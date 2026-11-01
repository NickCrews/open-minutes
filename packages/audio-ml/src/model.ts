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

export function ensureDownloaded<S extends ModelSpec>(
  spec: S,
  rootDir: string = MODELS_DIR,
) {
  const path = join(rootDir, spec.name);
  let downloaded = false;
  // Re-download if the dir is missing OR present-but-incomplete (e.g. an empty
  // dir left by an interrupted download or removed code). Checking the actual
  // files, not just the dir, makes this self-healing.
  if (!allFilesPresent(path, spec.files)) {
    downloadModel(spec, path);
    downloaded = true;
  }
  return {
    name: spec.name,
    downloaded,
    path,
    files: resolveFiles(path, spec.files) as ResolvedFiles<S["files"]>,
  };
}

function downloadModel(model: ModelSpec, dir: string): void {
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(`Downloading ${model.name} to ${dir}...`);
  mkdirSync(dir, { recursive: true });
  if (model.single_file) {
    const files = Object.keys(model.files);
    if (files.length !== 1) {
      throw new Error(
        `Model ${model.name} is marked as single_file but has ${files.length} files`,
      );
    }
    const filename = files[0]!;
    execSync(`curl -L -o "${join(dir, filename)}" "${model.url}"`, {
      stdio: "inherit",
    });
  } else {
    // k2-fsa release tarballs wrap everything in a single top-level folder
    // (e.g. sherpa-onnx-pyannote-segmentation-3-0/model.onnx). We extract into a
    // dir already named after the model, so strip that wrapper to land the files
    // flat at <dir>/<file> rather than <dir>/<wrapper>/<file>.
    execSync(
      `curl -L "${model.url}" | tar -xj --strip-components=1 -C "${dir}"`,
      {
        stdio: "inherit",
      },
    );
  }
  console.error(`  ✓ ${model.name}`);
}

function allFilesPresent(dir: string, files: DirListing, prefix = ""): boolean {
  for (const [filename, value] of Object.entries(files)) {
    const path = join(dir, prefix, filename);
    if (value === true) {
      if (!existsSync(path)) return false;
    } else if (!allFilesPresent(dir, value, join(prefix, filename))) {
      return false;
    }
  }
  return true;
}

function resolveFiles(
  dir: string,
  files: DirListing,
  prefix = "",
): Record<string, unknown> {
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
