import type {
  ListedRecording,
  RecordingLister,
} from "@open-minutes/core/recording-lister";
import { ensureYtDlpInstalled, run } from "@open-minutes/ytdlp";

/**
 * A channel (all its videos) or one playlist, as a body's meeting source.
 * Bodies that share a channel with their siblings (the Assembly, P&Z and the
 * school board all publish to the MOA channel) each get a playlist on it.
 */
export interface YouTubeSource {
  kind: "channel" | "playlist";
  /** A channel ID (UC...) or playlist ID (PL...), per `kind`. */
  id: string;
}

/** The URL of a {@link YouTubeSource}. */
function sourceUrl({ kind, id }: YouTubeSource): string {
  return kind === "channel"
    ? `https://www.youtube.com/channel/${id}`
    : `https://www.youtube.com/playlist?list=${id}`;
}

interface FlatEntry {
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

/**
 * The videos in a channel or playlist. A channel's span all its tabs
 * ("Videos", "Live", ...).
 */
async function listVideos(source: YouTubeSource): Promise<ListedRecording[]> {
  // Listing works from any IP, so it needs no egress.
  await ensureYtDlpInstalled();
  const { stdout } = await run(["--flat-playlist", "-J", sourceUrl(source)]);
  return flattenVideos(JSON.parse(stdout) as FlatEntry).map(
    ({ id, title }) => ({ id, title }),
  );
}

/**
 * Lists the videos in `source` (via yt-dlp, always direct: listing works from
 * datacenter IPs). Does no I/O until
 * {@link RecordingLister.listRecordings} is called.
 */
export function youtubeSource(source: YouTubeSource): RecordingLister {
  return { listRecordings: () => listVideos(source) };
}
