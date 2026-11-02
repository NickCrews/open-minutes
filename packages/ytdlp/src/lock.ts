import { open, readFile, rm, stat } from "node:fs/promises";

/** Whether a process with this PID is running. */
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the lock file at `path`, waiting while another live process holds
 * it, and resolves with a function that releases it. A lock left by a process
 * that died is taken over.
 */
export async function acquireLock(
  path: string,
  {
    timeoutMs,
    pollMs = 500,
    log = (line: string) => console.error(line),
  }: { timeoutMs: number; pollMs?: number; log?: (line: string) => void },
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  let waitingOn: number | undefined;
  for (;;) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = Number(await readFile(path, "utf8").catch(() => ""));
    if (!pid) {
      // Its owner may be between creating it and writing its PID.
      const age = await stat(path).then(
        (s) => Date.now() - s.mtimeMs,
        () => Infinity,
      );
      if (age > 5_000) await rm(path, { force: true });
    } else if (!isAlive(pid)) {
      await rm(path, { force: true });
      continue;
    } else if (waitingOn !== pid) {
      waitingOn = pid;
      log(`Waiting for process ${pid}, which holds ${path}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs / 1000}s waiting for ${path} (held by process ${pid || "unknown"})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
