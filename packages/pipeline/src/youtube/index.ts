import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";
import { webmOpusToWav } from "./opus";

export type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";

const execFileAsync = promisify(execFile);

function channelUrl(channelIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (channelIdOrUrl.includes("youtube.com")) {
    return channelIdOrUrl;
  }
  return `https://www.youtube.com/channel/${channelIdOrUrl}`;
}

function playlistUrl(playlistIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (playlistIdOrUrl.includes("youtube.com")) {
    return playlistIdOrUrl;
  }
  return `https://www.youtube.com/playlist?list=${playlistIdOrUrl}`;
}

/** The 11-character video ID, from either an ID or a watch/youtu.be URL. */
export function videoId(videoIdOrUrl: string): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(videoIdOrUrl)) return videoIdOrUrl;
  const url = new URL(videoIdOrUrl);
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.searchParams.get("v");
  if (!id) throw new Error(`No YouTube video ID in ${videoIdOrUrl}`);
  return id;
}

function videoUrl(videoIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (videoIdOrUrl.includes("youtube.com")) {
    return videoIdOrUrl;
  }
  return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
}

/** How to reach YouTube. See {@link youtubeFromEnv} for where each comes from. */
export interface YouTubeConfig {
  /**
   * A Netscape-format cookies.txt from a browser signed in to YouTube. YouTube
   * makes datacenter IPs (CI runners, servers) "sign in to confirm you're not a
   * bot", and these get past it. Anything else (a proxy, say) can go in
   * yt-dlp's own config file.
   */
  cookies?: string;
  /**
   * The object store's public base URL. With it, metadata and audio come
   * from the store (see {@link fetchStored}) instead of from YouTube.
   */
  objectStoreUrl?: string;
  /**
   * A GitHub token allowed to run the fetch-youtube-audio workflow. With it,
   * a video missing from the object store is fetched into it by that
   * workflow; without it, yt-dlp fetches it locally.
   */
  dispatchToken?: string;
}

/** Runs yt-dlp with the options every call shares. */
function ytDlp(config: YouTubeConfig, args: string[]) {
  return execFileAsync(
    "yt-dlp",
    [...(config.cookies ? ["--cookies", config.cookies] : []), ...args],
    // A busy channel's flat playlist runs to several MB.
    { maxBuffer: 100 * 1024 * 1024 },
  );
}

export interface FlatEntry {
  /** "url" for a video, "playlist" for a nested tab/playlist. */
  _type?: "url" | "playlist";
  id: string;
  title?: string;
  entries?: FlatEntry[];
}

/**
 * Pull the videos out of a yt-dlp `--flat-playlist` tree. A channel URL expands
 * into one nested playlist per tab ("Videos", "Live", ...), so the top-level
 * entries are playlists, not videos — walk down to the `_type: "url"` leaves.
 * Deduped by ID, since a video can appear under more than one tab.
 */
function flattenVideos(node: FlatEntry, seen = new Set<string>()): FlatEntry[] {
  if (node.entries) return node.entries.flatMap((e) => flattenVideos(e, seen));
  // A leaf without _type is still a video: older yt-dlp output omits it.
  if (node._type !== undefined && node._type !== "url") return [];
  if (seen.has(node.id)) return [];
  seen.add(node.id);
  return [node];
}

async function flatPlaylist(config: YouTubeConfig, url: string) {
  const { stdout } = await ytDlp(config, ["--flat-playlist", "-J", url]);
  return flattenVideos(JSON.parse(stdout) as FlatEntry);
}

/** The fields of yt-dlp's info JSON that {@link VideoMetadata} uses. */
interface YtDlpInfo {
  id: string;
  channel_id?: string;
  title?: string;
  description?: string;
  duration?: number | null;
  /** "YYYYMMDD". */
  upload_date?: string | null;
}

/**
 * With an object store configured, reads the info JSON the fetch-youtube-audio
 * workflow stored (see {@link fetchStored}), so this works where YouTube
 * blocks yt-dlp. Otherwise, or when the store can't supply it, asks yt-dlp.
 */
async function getMetadata(
  config: YouTubeConfig,
  videoIdOrUrl: string,
): Promise<VideoMetadata> {
  const stored = await fetchStored(config, videoId(videoIdOrUrl), "info.json");
  const raw = stored
    ? (JSON.parse(new TextDecoder().decode(stored)) as YtDlpInfo)
    : (JSON.parse(
        (await ytDlp(config, ["--skip-download", "-J", videoUrl(videoIdOrUrl)]))
          .stdout,
      ) as YtDlpInfo);
  return {
    id: raw.id,
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: raw.duration ?? null,
    uploadDate: isoDate(raw.upload_date),
  };
}

/** yt-dlp's "YYYYMMDD" as "YYYY-MM-DD"; null if absent or malformed. */
function isoDate(yyyymmdd: string | null | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Gets a video's Opus audio and decodes it to 16 kHz mono WAV with
 * {@link webmOpusToWav}, which needs no ffmpeg. With an object store
 * configured, the audio is the speech-quality copy stored there (see
 * {@link fetchStored}). Otherwise, or when the store can't supply it, yt-dlp
 * downloads YouTube's original Opus audio and that is decoded instead. The two
 * WAVs are very close (correlation ~0.997 on speech, same length, no lag) but
 * not byte-identical, so golden fixtures' sha256 are of the stored audio.
 */
async function ensureAudioDownloaded(
  config: YouTubeConfig,
  videoIdOrUrl: string,
  path: string,
  { overwrite = false }: { overwrite?: boolean } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !overwrite) return { downloaded: false };

  const url = videoUrl(videoIdOrUrl);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(`Downloading audio for ${url} to ${path}...`);
  const stored = await fetchStored(
    config,
    videoId(videoIdOrUrl),
    "speech.webm",
  );
  if (stored) {
    await webmOpusToWav(stored, path);
    return { downloaded: true };
  }
  const webm = `${path}.webm`;
  try {
    // The format the fetch-youtube-audio workflow re-encodes from. A single
    // format needs no ffmpeg to download.
    await ytDlp(config, [
      "-f",
      "bestaudio[ext=webm]",
      "--no-playlist",
      "-o",
      webm,
      url,
    ]);
    await webmOpusToWav(await readFile(webm), path);
  } finally {
    await rm(webm, { force: true });
  }
  return { downloaded: true };
}

/** The repo whose fetch-youtube-audio workflow fills the object store. */
const FETCH_YOUTUBE_AUDIO_REPO = "NickCrews/open-minutes";
const FETCH_YOUTUBE_AUDIO_POLL_MS = 5_000;
/** A fetch-youtube-audio run takes 2-6 minutes; this allows for a queue. */
const FETCH_YOUTUBE_AUDIO_TIMEOUT_MS = 20 * 60_000;

/**
 * Where a video's files live in the object store, as
 * `youtube/<video id>/<name>`:
 * - `info.json`: yt-dlp's metadata for the video
 * - `speech.webm`: YouTube's Opus audio re-encoded to 16 kHz mono Opus at
 *   24 kbps (~11 MB per hour), plenty for the models, which take 16 kHz mono
 * - `error.json`: written instead when the workflow fails, so clients stop
 *   waiting
 *
 * Keyed by video ID, so a video edited in place on YouTube (trimmed, or audio
 * muted over a copyright claim) keeps its old audio here. That's rare for
 * meetings, and the golden fixtures' sha256 checks would catch it.
 */
function storeKey(id: string, name: string) {
  return `youtube/${id}/${name}`;
}

/**
 * One of a video's files from the object store (see {@link storeKey}), or
 * null if the store isn't configured or can't supply it.
 *
 * The object store is the project's S3-compatible bucket of blobs, publicly
 * readable under {@link YouTubeConfig.objectStoreUrl}. YouTube blocks
 * datacenter IPs (CI, servers), so the fetch-youtube-audio workflow
 * (.github/workflows/fetch-youtube-audio.yml) gets past that and stores what
 * the pipeline needs from YouTube. On a miss, with
 * {@link YouTubeConfig.dispatchToken} set, this triggers the workflow and
 * waits for the file. Without the token, a miss returns null, so a caller on a
 * residential connection falls back to yt-dlp.
 */
async function fetchStored(
  config: YouTubeConfig,
  id: string,
  name: string,
): Promise<Uint8Array | null> {
  const base = config.objectStoreUrl?.replace(/\/$/, "");
  if (!base) return null;
  const url = `${base}/${storeKey(id, name)}`;
  const first = await download(url);
  if (first) return first;

  const token = config.dispatchToken;
  if (!token) return null;
  // The runner's clock and ours may differ; a minute's slack keeps a failure
  // from this run from looking like an old one.
  const requestedAt = Date.now() - 60_000;
  await requestFetch(id, token);
  console.error(
    `Waiting for the fetch-youtube-audio workflow to store ${url}...`,
  );
  const deadline = Date.now() + FETCH_YOUTUBE_AUDIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FETCH_YOUTUBE_AUDIO_POLL_MS));
    // A cache-busting query string, so a 404 from before the upload isn't
    // served again.
    const stored = await download(`${url}?t=${Date.now()}`);
    if (stored) return stored;
    const failure = await fetch(
      `${base}/${storeKey(id, "error.json")}?t=${Date.now()}`,
    );
    if (failure.ok) {
      const { failed_at, error, run_url } = (await failure.json()) as {
        failed_at: string;
        error: string;
        run_url: string;
      };
      if (Date.parse(failed_at) >= requestedAt) {
        throw new Error(
          `fetch-youtube-audio failed for ${id}: ${error} (${run_url})`,
        );
      }
    }
  }
  throw new Error(
    `Timed out waiting for fetch-youtube-audio to store ${url}; see https://github.com/${FETCH_YOUTUBE_AUDIO_REPO}/actions/workflows/fetch-youtube-audio.yml`,
  );
}

/** The body of `url`; null on a 404. */
async function download(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function requestFetch(id: string, token: string) {
  const res = await fetch(
    `https://api.github.com/repos/${FETCH_YOUTUBE_AUDIO_REPO}/actions/workflows/fetch-youtube-audio.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { video_id: id } }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Triggering fetch-youtube-audio for ${id}: HTTP ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Everything the pipeline gets from YouTube (via yt-dlp). Create one with
 * {@link youtube} or {@link youtubeFromEnv} and pass it around; tests pass a
 * fake instead (see `om/testing.ts`).
 */
export interface YouTube extends AudioProvider {
  /** The videos on a channel, across all its tabs ("Videos", "Live", ...). */
  videosInChannel(channelIdOrUrl: string): Promise<FlatEntry[]>;
  /**
   * The videos in one playlist. Bodies that share a channel with their
   * siblings (the Assembly, P&Z and the school board all publish to the MOA
   * channel) are usually separated by playlist, so this is how a video gets
   * attributed to the right body.
   */
  videosInPlaylist(playlistIdOrUrl: string): Promise<FlatEntry[]>;
}

/** A {@link YouTube} that uses `config`. Does no I/O until a method is called. */
export function youtube(config: YouTubeConfig = {}): YouTube {
  return {
    videosInChannel: (channelIdOrUrl) =>
      flatPlaylist(config, channelUrl(channelIdOrUrl)),
    videosInPlaylist: (playlistIdOrUrl) =>
      flatPlaylist(config, playlistUrl(playlistIdOrUrl)),
    getMetadata: (videoIdOrUrl) => getMetadata(config, videoIdOrUrl),
    ensureAudioDownloaded: (videoIdOrUrl, path, options) =>
      ensureAudioDownloaded(config, videoIdOrUrl, path, options),
  };
}

/**
 * A {@link YouTube} configured from environment variables:
 * - YOUTUBE_COOKIES: {@link YouTubeConfig.cookies}
 * - OBJECT_STORE_PUBLIC_URL: {@link YouTubeConfig.objectStoreUrl}
 * - YOUTUBE_AUDIO_DISPATCH_TOKEN: {@link YouTubeConfig.dispatchToken}
 */
export function youtubeFromEnv(env = process.env): YouTube {
  return youtube({
    cookies: env.YOUTUBE_COOKIES || undefined,
    objectStoreUrl: env.OBJECT_STORE_PUBLIC_URL || undefined,
    dispatchToken: env.YOUTUBE_AUDIO_DISPATCH_TOKEN || undefined,
  });
}
