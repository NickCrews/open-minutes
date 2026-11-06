import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordingDir } from "@open-minutes/blobstore";
import { decodeToWav, SAMPLE_RATE } from "@open-minutes/codecs";
import type { Site } from "@open-minutes/core/site";
import { storedSiteFromEnv } from "./stored-site";

const CACHE_ROOT = join(homedir(), ".cache", "open-minutes", "meetings");

interface AudioManifest {
  site: Site;
  /** The recording's ID on its site. */
  id: string;
  sha256: string;
  sample_rate: number;
  duration_sec: number;
}

export interface CachedAudio {
  path: string;
  manifest: AudioManifest;
}

/** A recording, by its site and its ID there. */
export interface RecordingRef {
  site: Site;
  /** A YouTube video ID, or an akleg.gov meeting ID. */
  id: string;
}

function meetingCacheDir({ site, id }: RecordingRef): string {
  return join(CACHE_ROOT, site, recordingDir(site, id));
}

/**
 * A recording's audio as 16 kHz mono WAV, from the per-machine cache,
 * downloaded (by way of the blob store) and decoded on first use. With
 * `sha256`, throws unless the WAV has that hash.
 */
export async function getCachedAudio(
  recording: RecordingRef & { sha256?: string },
): Promise<CachedAudio> {
  const dir = meetingCacheDir(recording);
  const audioPath = join(dir, "audio.wav");
  const manifestPath = join(dir, "manifest.json");
  mkdirSync(dir, { recursive: true });

  if (existsSync(manifestPath) && existsSync(audioPath)) {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as AudioManifest;
    const actual = await sha256File(audioPath);
    if (actual !== manifest.sha256) {
      throw new Error(
        `Cached audio sha256 ${actual} does not match manifest ${manifest.sha256}; delete ${dir} to re-download.`,
      );
    }
    if (recording.sha256 && manifest.sha256 !== recording.sha256) {
      throw new Error(
        `Cached audio sha256 ${manifest.sha256} does not match the expected ${recording.sha256} for ${recording.site} ${recording.id}.`,
      );
    }
    return { path: audioPath, manifest };
  }

  // `sha256` is of the decoded WAV, so the download is decoded here and only
  // the WAV kept.
  const adapter = storedSiteFromEnv(recording.site);
  const sourcePath = join(dir, "speech.webm");
  try {
    await adapter.downloadAudio(recording.id, sourcePath);
    await decodeToWav(sourcePath, audioPath);
  } finally {
    await rm(sourcePath, { force: true });
  }

  const sha256 = await sha256File(audioPath);
  if (recording.sha256 && sha256 !== recording.sha256) {
    throw new Error(
      `Downloaded audio sha256 ${sha256} does not match the expected ${recording.sha256} for ${recording.site} ${recording.id}. Did the recording change on its site?`,
    );
  }

  // decodeToWav writes a 44-byte header and 16-bit mono samples.
  const { size } = await stat(audioPath);
  const manifest: AudioManifest = {
    site: recording.site,
    id: recording.id,
    sha256,
    sample_rate: SAMPLE_RATE,
    duration_sec: (size - 44) / 2 / SAMPLE_RATE,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { path: audioPath, manifest };
}

export function isCached(recording: RecordingRef): boolean {
  const dir = meetingCacheDir(recording);
  return (
    existsSync(join(dir, "audio.wav")) && existsSync(join(dir, "manifest.json"))
  );
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
