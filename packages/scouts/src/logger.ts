import { format } from "node:util";
import type { Logger } from "@open-minutes/core/scout";

/** Where a run's lines go: stderr by default; tests collect them. */
export type Sink = (line: string) => void;

/** A run's logger, which counts the errors logged through it. */
export interface RunLogger {
  /** A logger whose messages start with `[prefix]`, eg a scout's id. */
  child(prefix: string): Logger;
  /** Errors logged so far, through any child. */
  readonly errors: number;
}

/**
 * A {@link RunLogger} writing to `sink`. With `annotate`, as in GitHub
 * Actions, warnings and errors are written as workflow commands, so they
 * show as annotations on the run.
 */
export function runLogger({
  sink = (line) => process.stderr.write(`${line}\n`),
  annotate = process.env.GITHUB_ACTIONS === "true",
}: { sink?: Sink; annotate?: boolean } = {}): RunLogger {
  let errors = 0;
  const line = (
    level: "info" | "warn" | "error",
    prefix: string,
    data: unknown[],
  ) => {
    const text = `[${prefix}] ${format(...data)}`;
    if (!annotate || level === "info") return sink(text);
    // Workflow commands end at a newline, so newlines are escaped.
    const escaped = text
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    sink(`::${level === "warn" ? "warning" : "error"}::${escaped}`);
  };
  return {
    child: (prefix) => ({
      info: (...data: unknown[]) => line("info", prefix, data),
      warn: (...data: unknown[]) => line("warn", prefix, data),
      error: (...data: unknown[]) => {
        errors++;
        line("error", prefix, data);
      },
    }),
    get errors() {
      return errors;
    },
  };
}
