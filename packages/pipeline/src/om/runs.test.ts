import { describe, expect, test } from "vitest";
import {
  ABANDONED_AFTER_MS,
  HUMAN_VERSION,
  MAX_ATTEMPTS,
  type RunRecord,
  type StepSpec,
  UNTRACKED_VERSION,
  isDue,
  stepState,
} from "./runs";

const NOW = new Date("2026-10-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const TRANSCRIPT: StepSpec = { name: "transcript", version: "2", after: [] };
const CHAPTERS: StepSpec = {
  name: "chapters",
  version: "1",
  after: ["transcript"],
};

function run(overrides: Partial<RunRecord> & { hoursAgo: number }): RunRecord {
  const { hoursAgo: h, ...rest } = overrides;
  const status = rest.status ?? "succeeded";
  return {
    step: "transcript",
    version: "2",
    status,
    started_at: hoursAgo(h),
    finished_at: status === "running" ? null : hoursAgo(h),
    error: status === "failed" ? "it broke" : null,
    ...rest,
  };
}

describe("stepState", () => {
  test("a meeting with no runs is pending", () => {
    expect(stepState([], TRANSCRIPT, NOW)).toEqual({
      kind: "pending",
      failures: 0,
    });
  });

  test("succeeded at the current version is done", () => {
    expect(stepState([run({ hoursAgo: 5 })], TRANSCRIPT, NOW)).toEqual({
      kind: "done",
      version: "2",
      at: hoursAgo(5),
    });
  });

  test("succeeded at an older version is stale", () => {
    for (const version of ["1", UNTRACKED_VERSION]) {
      expect(
        stepState([run({ hoursAgo: 5, version })], TRANSCRIPT, NOW),
      ).toMatchObject({ kind: "stale", version, because: "version" });
    }
  });

  test("a human-made output is never stale", () => {
    expect(
      stepState(
        [run({ hoursAgo: 5, version: HUMAN_VERSION })],
        TRANSCRIPT,
        NOW,
      ),
    ).toMatchObject({ kind: "done", version: HUMAN_VERSION });
  });

  test("the latest success decides, whatever order the runs come in", () => {
    const runs = [
      run({ hoursAgo: 1, version: "2" }),
      run({ hoursAgo: 9, version: "1" }),
    ];
    expect(stepState(runs, TRANSCRIPT, NOW)).toMatchObject({ kind: "done" });
    expect(stepState([...runs].reverse(), TRANSCRIPT, NOW)).toMatchObject({
      kind: "done",
    });
  });

  test("a failed reprocess leaves the earlier output standing", () => {
    const runs = [
      run({ hoursAgo: 9, version: "1" }),
      run({ hoursAgo: 1, status: "failed" }),
    ];
    expect(stepState(runs, TRANSCRIPT, NOW)).toMatchObject({
      kind: "stale",
      version: "1",
    });
  });

  test("a recent running run is running; an old one is abandoned", () => {
    expect(
      stepState([run({ hoursAgo: 1, status: "running" })], TRANSCRIPT, NOW),
    ).toEqual({ kind: "running", since: hoursAgo(1) });

    const abandoned = ABANDONED_AFTER_MS / 3_600_000 + 1;
    expect(
      stepState(
        [run({ hoursAgo: abandoned, status: "running" })],
        TRANSCRIPT,
        NOW,
      ),
    ).toEqual({ kind: "pending", failures: 0 });
  });

  test(`gives up after ${MAX_ATTEMPTS} failures at the current version`, () => {
    const failures = (n: number, version = "2") =>
      Array.from({ length: n }, (_, i) =>
        run({ hoursAgo: i + 1, status: "failed", version }),
      );
    expect(stepState(failures(MAX_ATTEMPTS - 1), TRANSCRIPT, NOW)).toEqual({
      kind: "pending",
      failures: MAX_ATTEMPTS - 1,
    });
    expect(stepState(failures(MAX_ATTEMPTS), TRANSCRIPT, NOW)).toEqual({
      kind: "failed",
      failures: MAX_ATTEMPTS,
      error: "it broke",
    });
    // A new version gets a fresh set of attempts.
    expect(stepState(failures(MAX_ATTEMPTS, "1"), TRANSCRIPT, NOW)).toEqual({
      kind: "pending",
      failures: 0,
    });
  });

  test("a step waits for the steps it is made from", () => {
    expect(stepState([], CHAPTERS, NOW)).toEqual({
      kind: "blocked",
      on: "transcript",
    });
    expect(
      stepState([run({ hoursAgo: 3, status: "failed" })], CHAPTERS, NOW),
    ).toMatchObject({ kind: "blocked" });
    expect(stepState([run({ hoursAgo: 3 })], CHAPTERS, NOW)).toEqual({
      kind: "pending",
      failures: 0,
    });
  });

  test("redoing an earlier step makes a later one stale", () => {
    const chapters = run({ hoursAgo: 5, step: "chapters", version: "1" });
    expect(
      stepState([run({ hoursAgo: 6 }), chapters], CHAPTERS, NOW),
    ).toMatchObject({ kind: "done" });
    expect(
      stepState(
        [run({ hoursAgo: 6 }), chapters, run({ hoursAgo: 1 })],
        CHAPTERS,
        NOW,
      ),
    ).toMatchObject({ kind: "stale", because: "transcript" });
  });
});

describe("isDue", () => {
  test("pending always; stale and failed only when asked", () => {
    const stale = stepState(
      [run({ hoursAgo: 1, version: "1" })],
      TRANSCRIPT,
      NOW,
    );
    const failed = stepState(
      Array.from({ length: MAX_ATTEMPTS }, () =>
        run({ hoursAgo: 1, status: "failed" }),
      ),
      TRANSCRIPT,
      NOW,
    );
    expect(isDue({ kind: "pending", failures: 0 })).toBe(true);
    expect(isDue(stale)).toBe(false);
    expect(isDue(stale, { stale: true })).toBe(true);
    expect(isDue(failed)).toBe(false);
    expect(isDue(failed, { retry: true })).toBe(true);
    expect(
      isDue({ kind: "running", since: NOW }, { stale: true, retry: true }),
    ).toBe(false);
    expect(isDue({ kind: "blocked", on: "transcript" }, { stale: true })).toBe(
      false,
    );
  });
});
