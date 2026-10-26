import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { akleg } from "@open-minutes/akleg";
import { blobStore } from "@open-minutes/blobstore";
import { youtubeConfigFromEnv, youtubeFetchAudio } from "@open-minutes/youtube";
import type { AudioTools } from "./harness";

const run = promisify(execFile);

/** Encodes for speech: 16 kHz mono Opus at 24 kbps, in WebM. Needs ffmpeg. */
export const ENCODE_SCRIPT = fileURLToPath(
  new URL("../../../.github/scripts/encode-speech-audio.sh", import.meta.url),
);

export async function encodeSpeech(input: string, output: string) {
  await run(ENCODE_SCRIPT, [input, output]);
}

/** An audio file's duration in seconds, from ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const secs = Number(stdout.trim());
  if (!Number.isFinite(secs)) {
    throw new Error(`ffprobe gave no duration for ${file}: "${stdout.trim()}"`);
  }
  return secs;
}

/**
 * Uploads with the AWS CLI, as the workflows do, to the bucket
 * BLOB_STORE_BUCKET names. Credentials and endpoint come from the AWS_*
 * variables, else the BLOB_STORE_* ones in .env.example.
 */
export function awsUpload(env = process.env) {
  return async (file: string, key: string) => {
    const bucket = env.BLOB_STORE_BUCKET;
    if (!bucket) throw new Error("BLOB_STORE_BUCKET is not set");
    await run(
      "aws",
      [
        "s3",
        "cp",
        file,
        `s3://${bucket}/${key}`,
        "--content-type",
        "audio/webm",
        "--no-progress",
      ],
      {
        env: {
          ...env,
          AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL ?? env.BLOB_STORE_ENDPOINT,
          AWS_ACCESS_KEY_ID:
            env.AWS_ACCESS_KEY_ID ?? env.BLOB_STORE_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY:
            env.AWS_SECRET_ACCESS_KEY ?? env.BLOB_STORE_SECRET_ACCESS_KEY,
          AWS_DEFAULT_REGION:
            env.AWS_DEFAULT_REGION ?? env.BLOB_STORE_REGION ?? "auto",
          // Some S3-compatible stores (R2) reject the checksum headers newer
          // AWS CLIs send by default.
          AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
          AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
        },
      },
    );
  };
}

/**
 * Throws unless {@link awsUpload} can run: BLOB_STORE_BUCKET is set and the
 * AWS CLI is on PATH. Checked before any fetch, so a machine that can't
 * upload doesn't count a failure against every recording it tries.
 */
export async function assertCanUpload(env = process.env) {
  if (!env.BLOB_STORE_BUCKET) {
    throw new Error(
      "BLOB_STORE_BUCKET is not set, so audio can't be uploaded; pass --audio-cap 0 to only scout",
    );
  }
  try {
    await run("aws", ["--version"]);
  } catch {
    throw new Error(
      "The AWS CLI isn't on PATH, so audio can't be uploaded; pass --audio-cap 0 to only scout",
    );
  }
}

/** The {@link AudioTools} a real run uses. */
export function realAudioTools(env = process.env): AudioTools {
  return {
    fetchAudio: {
      youtube: youtubeFetchAudio(youtubeConfigFromEnv(env)),
      akleg: akleg().fetchAudio,
    },
    encode: encodeSpeech,
    duration: probeDuration,
    upload: awsUpload(env),
    store: blobStore(),
  };
}
