/**
 * A video's files, as the fetch-youtube-audio workflow
 * (.github/workflows/fetch-youtube-audio.yml) publishes them.
 */
export interface FetchedVideo {
  /** Its `RecordingMetadata`, as `metadataToJson` writes it. */
  metadataJson: Uint8Array<ArrayBuffer>;
  /** Its audio re-encoded for speech, as `youtube().downloadAudio` gives it. */
  speechWebm: Uint8Array<ArrayBuffer>;
}

/** What the workflow publishes instead when it can't fetch a video. */
interface FetchFailure {
  error: string;
  /** The workflow run that failed. */
  run_url: string;
}

interface WorkflowRun {
  status: string;
  conclusion: string | null;
  html_url: string;
}

interface Artifact {
  name: string;
  archive_download_url: string;
}

/** The repo whose fetch-youtube-audio workflow fetches videos. */
const FETCH_YOUTUBE_AUDIO_REPO = "NickCrews/open-minutes";
const FETCH_YOUTUBE_AUDIO_POLL_MS = 5_000;
/** A fetch-youtube-audio run takes 2-6 minutes; this allows for a queue. */
const FETCH_YOUTUBE_AUDIO_TIMEOUT_MS = 20 * 60_000;

/**
 * The branch whose fetch-youtube-audio workflow runs: in a pull request's
 * GitHub Actions run, the pull request's own (GITHUB_HEAD_REF), so the
 * workflow publishes what this code expects; else main.
 */
function workflowRef(): string {
  return process.env.GITHUB_HEAD_REF || "main";
}

/**
 * Runs the fetch-youtube-audio workflow for `youtubeId`, waits for it, and
 * downloads the files it published. `token` is a GitHub token allowed to run
 * the workflow and read its artifacts (Actions: write). Throws if the run
 * fails or times out.
 */
export async function fetchVideoViaWorkflow(
  youtubeId: string,
  token: string,
): Promise<FetchedVideo> {
  const dispatched = (await github(
    `actions/workflows/fetch-youtube-audio.yml/dispatches`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        ref: workflowRef(),
        inputs: { video_id: youtubeId },
        return_run_details: true,
      }),
    },
  ).then((res) => res.json())) as { workflow_run_id: number; html_url: string };
  const runId = dispatched.workflow_run_id;
  console.error(
    `Waiting for fetch-youtube-audio to fetch ${youtubeId}: ${dispatched.html_url}`,
  );

  const run = await waitForRun(runId, token);
  const { artifacts } = (await github(
    `actions/runs/${runId}/artifacts`,
    token,
  ).then((res) => res.json())) as { artifacts: Artifact[] };
  const download = async (name: string) => {
    const artifact = artifacts.find((a) => a.name === name);
    if (!artifact) return null;
    // Unzipped artifacts download as the file itself. The download redirects
    // to blob storage, and fetch drops the Authorization header on the way.
    const res = await github(artifact.archive_download_url, token);
    return new Uint8Array(await res.arrayBuffer());
  };

  if (run.conclusion !== "success") {
    const error = await download("error.json");
    const failure =
      error && (JSON.parse(new TextDecoder().decode(error)) as FetchFailure);
    throw new Error(
      `fetch-youtube-audio failed for ${youtubeId}: ${failure?.error ?? run.conclusion} (${run.html_url})`,
    );
  }
  const metadataJson = await download("metadata.json");
  const speechWebm = await download("speech.webm");
  if (!metadataJson || !speechWebm) {
    throw new Error(
      `fetch-youtube-audio for ${youtubeId} published no metadata.json or speech.webm (${run.html_url})`,
    );
  }
  return { metadataJson, speechWebm };
}

async function waitForRun(runId: number, token: string): Promise<WorkflowRun> {
  const deadline = Date.now() + FETCH_YOUTUBE_AUDIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FETCH_YOUTUBE_AUDIO_POLL_MS));
    const run = (await github(`actions/runs/${runId}`, token).then((res) =>
      res.json(),
    )) as WorkflowRun;
    if (run.status === "completed") return run;
  }
  throw new Error(
    `Timed out waiting for fetch-youtube-audio run ${runId}; see https://github.com/${FETCH_YOUTUBE_AUDIO_REPO}/actions/runs/${runId}`,
  );
}

/**
 * A GitHub API request, by path under the repo or by full URL; throws unless
 * it succeeds.
 */
async function github(
  pathOrUrl: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://api.github.com/repos/${FETCH_YOUTUBE_AUDIO_REPO}/${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url}: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return res;
}
