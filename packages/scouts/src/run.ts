import type { DB } from "@open-minutes/db";
import type { Scout } from "@open-minutes/core/scout";
import {
  type AudioTools,
  type ScanResult,
  type StoreAudioResult,
  dueScouts,
  scan,
  storeAudio,
} from "./harness";
import type { RunLogger } from "./logger";

/** Recordings whose audio one run fetches, at most. */
export const DEFAULT_AUDIO_CAP = 10;

export interface RunOptions {
  db: DB;
  scouts: readonly Scout[];
  /** Runs this scout only, whatever its schedule. */
  scoutId?: string;
  logger: RunLogger;
  tools: AudioTools;
  audioCap?: number;
  now?: Date;
  signal?: AbortSignal;
  dryRun?: boolean;
}

export interface RunResult {
  scans: ScanResult[];
  audio: StoreAudioResult;
  /**
   * False when anything logged an error: a failed scout, a rejected report,
   * one recording a scout couldn't read, or a failed audio fetch.
   */
  ok: boolean;
}

/**
 * `pnpm scout run`: runs the scouts that are due (or `scoutId`), then fetches
 * audio for up to `audioCap` recordings.
 */
export async function runScouts({
  db,
  scouts,
  scoutId,
  logger,
  tools,
  audioCap = DEFAULT_AUDIO_CAP,
  now = new Date(),
  signal,
  dryRun,
}: RunOptions): Promise<RunResult> {
  let toRun: readonly Scout[];
  if (scoutId) {
    const scout = scouts.find((s) => s.id === scoutId);
    if (!scout) {
      throw new Error(
        `No scout "${scoutId}"; there are ${scouts.map((s) => s.id).join(", ")}`,
      );
    }
    toRun = [scout];
  } else {
    toRun = dueScouts(scouts, now);
  }
  logger
    .child("harness")
    .info(`running ${toRun.map((s) => s.id).join(", ") || "no scouts"}`);
  const scans = await scan({ db, scouts: toRun, logger, now, signal, dryRun });
  const audio = await storeAudio({
    db,
    tools,
    logger,
    cap: audioCap,
    signal,
    dryRun,
  });
  return { scans, audio, ok: logger.errors === 0 };
}
