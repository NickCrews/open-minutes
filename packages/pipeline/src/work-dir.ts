import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteMeeting } from "./sites";

/**
 * Root of the per-meeting work directories. Lives at
 * packages/pipeline/data/meetings/, gitignored via the root `data/` rule.
 */
export const DEFAULT_WORK_ROOT = fileURLToPath(
  new URL("../data/meetings/", import.meta.url),
);

/**
 * The name of a meeting's work directory under the work root: its site and its
 * ID there, with anything but letters, digits, `-` and `_` (an akleg.gov ID's
 * spaces and colons) replaced by `-`.
 */
export function workDirName({ siteKind, siteId }: SiteMeeting): string {
  return `${siteKind}_${siteId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/** A meeting's work directory under `workRoot`, created if missing. */
export async function meetingWorkDir(
  workRoot: string,
  meeting: SiteMeeting,
): Promise<string> {
  const dir = join(workRoot, workDirName(meeting));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Each step's output in a work directory, by the step that writes it. */
export const ARTIFACTS = {
  audio: "audio.wav",
  transcription: "transcription.json",
  cleaned: "cleaned.json",
  diarization: "diarization.json",
  segments: "segments.json",
  embeddings: "embeddings.json",
  recognition: "recognition.json",
} as const;

export type Artifact = keyof typeof ARTIFACTS;

/** The path of `artifact` in `dir`. */
export function artifactPath(dir: string, artifact: Artifact): string {
  return join(dir, ARTIFACTS[artifact]);
}

/**
 * Read a JSON artifact a previous step wrote. Missing means that step hasn't
 * run: the error names it.
 */
export async function readArtifact<T>(
  dir: string,
  artifact: Exclude<Artifact, "audio">,
  writtenBy: string,
): Promise<T> {
  const path = artifactPath(dir, artifact);
  if (!existsSync(path))
    throw new Error(
      `No ${ARTIFACTS[artifact]} in ${dir}: run ${writtenBy} first.`,
    );
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeArtifact(
  dir: string,
  artifact: Exclude<Artifact, "audio">,
  value: unknown,
): Promise<void> {
  await writeFile(artifactPath(dir, artifact), JSON.stringify(value, null, 2));
}

/** The audio a step needs, or an error naming the step that downloads it. */
export function requireAudio(dir: string): string {
  const path = artifactPath(dir, "audio");
  if (!existsSync(path))
    throw new Error(
      `No ${ARTIFACTS.audio} in ${dir}: run downloadAudio first.`,
    );
  return path;
}
