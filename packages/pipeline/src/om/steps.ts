import type { DB } from "@open-minutes/db";
import type { YouTube } from "../youtube";
import type { StepSpec } from "./runs";
import { transcriptStep } from "./transcript";

/** A transaction on the database, which a step writes its output in. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** The meeting a step runs for. */
export interface StepMeeting {
  id: number;
  youtubeId: string;
  /** Body slug (eg "gbos"). */
  body: string;
}

export interface StepContext {
  db: DB;
  meeting: StepMeeting;
  yt: YouTube;
  /** The meeting's work directory, for cached stage artifacts. */
  workDir: string;
}

/** What a step made, ready to be written. */
export interface StepOutput {
  /** Recorded on the run: what it was made with, and from. */
  details: Record<string, unknown>;
  /** One line for the log. */
  summary: string;
  /**
   * Write the output to the database. Called in the transaction that marks
   * the run succeeded, so the two commit together or not at all.
   */
  write(tx: Tx): Promise<void>;
}

/**
 * One processing step: a {@link StepSpec} (name, version, what it is made
 * from) plus the code that makes its output. `run` does the slow work outside
 * any transaction and returns the output for the processor to write.
 */
export interface Step extends StepSpec {
  run(context: StepContext): Promise<StepOutput>;
}

/**
 * Every step that is built, in the order they run. The schema also has room
 * for "chapters" and "summary" (see ADR 0005); each joins this list, with
 * `after: ["transcript"]`, once its generation exists.
 */
export const STEPS: readonly Step[] = [transcriptStep];
