import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const MODELS_DIR = new URL("./models/", import.meta.url).pathname;

export interface DirListing {
  readonly [filename: string]: true | DirListing;
}

export interface ModelSpec {
  name: string;
  url: string;
  files: DirListing;
  single_file?: boolean;
}

export type ResolvedFiles<T extends DirListing> = {
  [K in keyof T]: T[K] extends true
  ? string
  : T[K] extends DirListing
  ? ResolvedFiles<T[K]>
  : never;
};

// const specs = [
//   {
//     name: "sherpa-onnx-pyannote-segmentation-3-0",
//     url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
//     files: {
//       TODO
//     },
//   },
//   {
//     name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
//     url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recog-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.tar.bz2",
//     files: {
//       TODO
//       },
//     },
//     {
//       name: "silero_vad",
//       url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
//       single_file: true,
//       files: {
//         "silero_vad.onnx": true,
//       },
//     },
//   ] as const satisfies ModelSpec[];

export function ensureDownloaded<S extends ModelSpec>(spec: S, rootDir: string = MODELS_DIR) {
  const path = join(rootDir, spec.name);
  let downloaded = false;
  if (!existsSync(path)) {
    downloadModel(spec, path);
    downloaded = true;
  } else {
    // console.log(`Model ${spec.name} already exists at ${path}`);
  }
  return {
    name: spec.name,
    downloaded,
    path,
    files: resolveFiles(path, spec.files) as ResolvedFiles<S["files"]>,
  };
}

function downloadModel(model: ModelSpec, dir: string): void {
  console.log(`Downloading ${model.name} to ${dir}...`);
  mkdirSync(dir, { recursive: true });
  if (model.single_file) {
    const files = Object.keys(model.files);
    if (files.length !== 1) {
      throw new Error(`Model ${model.name} is marked as single_file but has ${files.length} files`);
    }
    const filename = files[0]!;
    execSync(
      `curl -L -o "${join(dir, filename)}" "${model.url}"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`curl -L "${model.url}" | tar -xj -C "${dir}"`, {
      stdio: "inherit",
    });
  }
  console.log(`  ✓ ${model.name}`);
}

function resolveFiles(dir: string, files: DirListing, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [filename, value] of Object.entries(files)) {
    const path = join(dir, prefix, filename);
    if (value === true) {
      out[filename] = path;
    } else {
      out[filename] = resolveFiles(dir, value, join(prefix, filename));
    }
  }
  return out;
}