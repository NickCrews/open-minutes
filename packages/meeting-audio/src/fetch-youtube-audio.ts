import type {
  BlobFile,
  BlobStore,
  YoutubeVideoFiles,
} from "@open-minutes/blobstore";

/** What the workflow writes when it can't fetch a video. */
interface FetchFailure {
  /** ISO 8601. */
  failed_at: string;
  error: string;
  /** The workflow run that failed. */
  run_url: string;
}

/** The repo whose fetch-youtube-audio workflow fills the blob store. */
const FETCH_YOUTUBE_AUDIO_REPO = "NickCrews/open-minutes";
const FETCH_YOUTUBE_AUDIO_POLL_MS = 5_000;
/** A fetch-youtube-audio run takes 2-6 minutes; this allows for a queue. */
const FETCH_YOUTUBE_AUDIO_TIMEOUT_MS = 20 * 60_000;

/**
 * The contents of one of `youtubeId`'s files in `store`, the one `pick`
 * chooses, or null if it isn't stored.
 *
 * On a miss, with `dispatchToken` (a GitHub token allowed to run the
 * fetch-youtube-audio workflow), this triggers the workflow and waits for the
 * file, throwing if the workflow fails or times out. Without the token, a
 * miss returns null.
 */
export async function fetchYoutubeVideoFile(
  store: BlobStore,
  youtubeId: string,
  pick: (files: YoutubeVideoFiles) => BlobFile,
  dispatchToken?: string,
): Promise<Uint8Array | null> {
  const files = store.youtube(youtubeId);
  const file = pick(files);
  const first = await file.get();
  if (first) return first;

  if (!dispatchToken) return null;
  // The runner's clock and ours may differ; a minute's slack keeps a failure
  // from this run from looking like an old one.
  const requestedAt = Date.now() - 60_000;
  await requestFetch(youtubeId, dispatchToken);
  console.error(
    `Waiting for the fetch-youtube-audio workflow to store ${file.url}...`,
  );
  const deadline = Date.now() + FETCH_YOUTUBE_AUDIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FETCH_YOUTUBE_AUDIO_POLL_MS));
    // Bypassing the cache, so a 404 from before the upload isn't served again.
    const stored = await file.get({ bypassCache: true });
    if (stored) return stored;
    const error = await files.errorJson.get({ bypassCache: true });
    const failure = error && (parseJson(error) as FetchFailure);
    if (failure && Date.parse(failure.failed_at) >= requestedAt) {
      throw new Error(
        `fetch-youtube-audio failed for ${youtubeId}: ${failure.error} (${failure.run_url})`,
      );
    }
  }
  throw new Error(
    `Timed out waiting for fetch-youtube-audio to store ${file.url}; see https://github.com/${FETCH_YOUTUBE_AUDIO_REPO}/actions/workflows/fetch-youtube-audio.yml`,
  );
}

/** A stored JSON file's contents. */
export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function requestFetch(youtubeId: string, token: string) {
  const res = await fetch(
    `https://api.github.com/repos/${FETCH_YOUTUBE_AUDIO_REPO}/actions/workflows/fetch-youtube-audio.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { video_id: youtubeId } }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Triggering fetch-youtube-audio for ${youtubeId}: HTTP ${res.status} ${await res.text()}`,
    );
  }
}
