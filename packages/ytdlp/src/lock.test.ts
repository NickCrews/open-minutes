import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "./lock";

let dir: string;
let path: string;
const quiet = { timeoutMs: 5_000, pollMs: 20, log: () => {} };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ytdlp-lock-"));
  path = join(dir, "manager.lock");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it("waits for the holder to release it", async () => {
  const release = await acquireLock(path, quiet);
  expect(await readFile(path, "utf8")).toBe(String(process.pid));
  let second = false;
  const waiting = acquireLock(path, quiet).then((r) => {
    second = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 100));
  expect(second).toBe(false);
  await release();
  const releaseSecond = await waiting;
  await releaseSecond();
  expect(second).toBe(true);
});

it("takes over a lock left by a process that died", async () => {
  const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  await writeFile(path, String(dead));
  const release = await acquireLock(path, quiet);
  expect(await readFile(path, "utf8")).toBe(String(process.pid));
  await release();
});

it("gives up after the timeout", async () => {
  const release = await acquireLock(path, quiet);
  await expect(acquireLock(path, { ...quiet, timeoutMs: 100 })).rejects.toThrow(
    /Timed out/,
  );
  await release();
});
