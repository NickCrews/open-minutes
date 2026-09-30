import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CONFIG_FILE, findConfig, loadConfig } from "./config";

const dirs: string[] = [];

/** A temporary project whose config file holds `source`. */
function project(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "dbranch-config-"));
  dirs.push(root);
  writeFileSync(join(root, CONFIG_FILE), source);
  return root;
}

const DATASET = `{ name: "tiny", fingerprint: "1", async apply() {} }`;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("findConfig", () => {
  test("finds the config in a directory above", () => {
    const root = project("export default { datasets: {} };");
    const nested = join(root, "packages", "web");
    mkdirSync(nested, { recursive: true });
    expect(findConfig(nested)).toBe(join(root, CONFIG_FILE));
  });

  test("finds this repository's config from this package", () => {
    expect(findConfig(import.meta.dirname)).toMatch(
      new RegExp(`/${CONFIG_FILE.replace(".", "\\.")}$`),
    );
  });
});

describe("loadConfig", () => {
  test("loads the datasets and default", async () => {
    const root = project(
      `export default { datasets: { tiny: ${DATASET} }, defaultDataset: "tiny" };`,
    );
    const config = await loadConfig(join(root, CONFIG_FILE));
    expect(Object.keys(config.datasets)).toEqual(["tiny"]);
    expect(config.defaultDataset).toBe("tiny");
  });

  test("rejects a defaultDataset that isn't one of the datasets", async () => {
    const root = project(
      `export default { datasets: { tiny: ${DATASET} }, defaultDataset: "dev" };`,
    );
    await expect(loadConfig(join(root, CONFIG_FILE))).rejects.toThrow(
      /defaultDataset "dev" is not one of its datasets \(tiny\)/,
    );
  });

  test("rejects a file without a default export", async () => {
    const root = project(`export const datasets = {};`);
    await expect(loadConfig(join(root, CONFIG_FILE))).rejects.toThrow(
      /must `export default defineConfig/,
    );
  });
});
