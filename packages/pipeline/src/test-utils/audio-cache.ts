import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { downloadVideoAudio } from "@open-minutes/core/youtube";

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

export function meetingCacheDir(youtube_id: string): string {
  return join(CACHE_ROOT, youtube_id);
}

export async function getCachedAudio(fixture: {
  youtubeId: string;
  sha256?: string;
}): Promise<CachedAudio> {
  const dir = meetingCacheDir(fixture.youtubeId);
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
    if (fixture.sha256 && manifest.sha256 !== fixture.sha256) {
      throw new Error(
        `Cached audio sha256 ${manifest.sha256} does not match golden _audio_sha256 ${fixture.sha256} for ${fixture.youtubeId}.`,
      );
    }
    return { path: audioPath, manifest };
  }

  await downloadVideoAudio(fixture.youtubeId, audioPath, "skip");

  const sha256 = await sha256File(audioPath);
  if (fixture.sha256 && sha256 !== fixture.sha256) {
    throw new Error(
      `Downloaded audio sha256 ${sha256} does not match golden _audio_sha256 ${fixture.sha256} for ${fixture.youtubeId}. Did the YouTube source change?`,
    );
  }

  const wave = sherpa.readWave(audioPath);
  const manifest: AudioManifest = {
    youtube_id: fixture.youtubeId,
    sha256,
    sample_rate: wave.sampleRate,
    duration_sec: wave.samples.length / wave.sampleRate,
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
