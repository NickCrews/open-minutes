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
import { decodeToWav, SAMPLE_RATE } from "@open-minutes/codecs";
import { storedYoutubeFromEnv } from "./stored-youtube";

const CACHE_ROOT = join(homedir(), ".cache", "open-minutes", "meetings");

interface AudioManifest {
  youtube_id: string;
  sha256: string;
  sample_rate: number;
  duration_sec: number;
}

export interface CachedAudio {
  path: string;
  manifest: AudioManifest;
}

function meetingCacheDir(youtube_id: string): string {
  return join(CACHE_ROOT, youtube_id);
}

/**
 * A YouTube video's audio as 16 kHz mono WAV, from the per-machine cache,
 * downloaded and decoded on first use. With `sha256`, throws unless the WAV
 * has that hash.
 */
export async function getCachedAudio(video: {
  youtubeId: string;
  sha256?: string;
}): Promise<CachedAudio> {
  const dir = meetingCacheDir(video.youtubeId);
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
    if (video.sha256 && manifest.sha256 !== video.sha256) {
      throw new Error(
        `Cached audio sha256 ${manifest.sha256} does not match the expected ${video.sha256} for ${video.youtubeId}.`,
      );
    }
    return { path: audioPath, manifest };
  }

  // `sha256` is of the decoded WAV, so the download is decoded here and only
  // the WAV kept.
  const youtube = storedYoutubeFromEnv();
  const sourcePath = join(dir, `audio.${youtube.audioExtension}`);
  try {
    await youtube.ensureAudioDownloaded(video.youtubeId, sourcePath, {
      overwrite: true,
    });
    await decodeToWav(sourcePath, audioPath);
  } finally {
    await rm(sourcePath, { force: true });
  }

  const sha256 = await sha256File(audioPath);
  if (video.sha256 && sha256 !== video.sha256) {
    throw new Error(
      `Downloaded audio sha256 ${sha256} does not match the expected ${video.sha256} for ${video.youtubeId}. Did the YouTube source change?`,
    );
  }

  // decodeToWav writes a 44-byte header and 16-bit mono samples.
  const { size } = await stat(audioPath);
  const manifest: AudioManifest = {
    youtube_id: video.youtubeId,
    sha256,
    sample_rate: SAMPLE_RATE,
    duration_sec: (size - 44) / 2 / SAMPLE_RATE,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { path: audioPath, manifest };
}

export function isCached(youtube_id: string): boolean {
  const dir = meetingCacheDir(youtube_id);
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
