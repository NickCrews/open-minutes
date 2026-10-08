import { describe, expect, it } from "vitest";
import {
  checkChapters,
  checkFixtures,
  checkMeetingSlug,
  checkPsv,
  formatIssue,
  meetingDirs,
} from "./check";
import { loadAllTestData } from "./test-data";

/** A PSV from `[onset, speaker | word]` rows; speakers start with "@". */
function psv(...rows: [string, string][]): string {
  return rows
    .map(([t, x]) =>
      x.startsWith("@")
        ? `${t}|meta|{"begin_speaker":"${x.slice(1)}"}`
        : `${t}|text|${x}`,
    )
    .join("\n");
}

const lint = async (content: string) =>
  (await checkPsv(content, "t.psv")).map(
    (i) => `${i.line}: ${i.severity}: ${i.message}`,
  );

describe("all fixtures", () => {
  it("have no errors", async () => {
    // Fix these at the file:line given, or run `pnpm fixtures:check`.
    expect(
      (await checkFixtures())
        .filter((i) => i.severity === "error")
        .map((i) => formatIssue(i)),
    ).toEqual([]);
  });

  it("include chapters for at least one golden meeting", async () => {
    expect(loadAllTestData().meetings.some((m) => m.chapters)).toBe(true);
    expect(meetingDirs().length).toBeGreaterThan(0);
  });
});

describe("checkMeetingSlug", () => {
  const ok = (
    slug: string,
    date: string | null = "2026-03-23",
    body_ids = ["gbos"],
  ) => checkMeetingSlug({ slug, body_ids, date }) === null;

  it("wants <body>-<date>, with an optional suffix", async () => {
    expect(ok("gbos-2026-03-23")).toBe(true);
    expect(ok("gbos-2026-03-23-special")).toBe(true);
    expect(ok("gbos-2026-03-24")).toBe(false);
    expect(ok("gbos_9HoIM5INxpI")).toBe(false);
    expect(ok("pzc-2026-03-23")).toBe(false);
    expect(ok("gbos-2026-03-23x")).toBe(false);
  });

  it("lets a joint meeting go by any of its bodies", async () => {
    expect(ok("gbos-2026-03-23", "2026-03-23", ["gbos", "luc"])).toBe(true);
    expect(ok("luc-2026-03-23", "2026-03-23", ["gbos", "luc"])).toBe(true);
    expect(ok("pzc-2026-03-23", "2026-03-23", ["gbos", "luc"])).toBe(false);
  });

  it("wants <body>-<suffix> when the date is unknown", async () => {
    expect(ok("gbos-budget-workshop", null)).toBe(true);
    expect(ok("gbos", null)).toBe(false);
  });
});

describe("checkPsv", () => {
  it("accepts a well-formed transcript", async () => {
    expect(
      await lint(
        psv(
          ["0:00:01.00", "@identified:kyle-kelley"],
          ["0:00:01.00", "Hello."],
          ["0:00:02.00", "@segmented:spk-1"],
          ["0:00:02.00", "Hi."],
        ),
      ),
    ).toEqual([]);
  });

  it("catches disfluencies the clean stage removes", async () => {
    expect(
      await lint(
        psv(
          ["0:00:01.00", "@unlabeled"],
          ["0:00:01.00", "Um,"],
          ["0:00:01.20", "the"],
          ["0:00:01.40", "the"],
          ["0:00:01.60", "vote."],
        ),
      ),
    ).toEqual([
      '2: error: filler "Um," should not be in a transcript; run `pnpm fixtures:clean`',
      '3: error: stutter "The" should not be in a transcript; run `pnpm fixtures:clean`',
    ]);
  });

  it("catches a speaker marker inserted a line off", async () => {
    expect(
      await lint(
        psv(
          ["0:00:01.00", "@identified:kyle-kelley"],
          ["0:00:01.00", "Thank"],
          ["0:00:01.50", "@segmented:spk-1"],
          ["0:00:01.20", "you."],
          ["0:00:01.50", "Next."],
        ),
      ),
    ).toEqual([
      "3: error: speaker marker at 0:00:01.50 but its first word starts at 0:00:01.20; a marker goes on the line just before its first word, with the same onset",
    ]);
  });

  it("warns about a speaker marker a word off a sentence edge", async () => {
    expect(
      await lint(
        psv(
          ["0:00:01.00", "@identified:christopher-constant"],
          ["0:00:01.00", "Allegiance?"],
          ["0:00:04.68", "I"],
          ["0:00:04.84", "@identified:jared-goecker"],
          ["0:00:04.84", "pledge"],
          ["0:00:05.32", "allegiance."],
        ),
      ),
    ).toEqual([
      '4: warning: speaker change at 0:00:04.84 splits a sentence; the pause at 0:00:04.68 is longer (3.68s vs 0.16s), so "I" may belong to the other speaker. Move the boundary to the sentence edge where the voice changes',
    ]);
  });

  it("catches words out of order and empty speakers", async () => {
    expect(
      await lint(
        psv(
          ["0:00:01.00", "@unlabeled"],
          ["0:00:02.00", "@unlabeled"],
          ["0:00:02.00", "late"],
          ["0:00:01.50", "early"],
          ["0:00:03.00", "@unlabeled"],
        ),
      ),
    ).toEqual([
      "1: error: speaker marker with no words after it",
      "4: error: word onset 0:00:01.50 is before the previous word's (0:00:02.00); words must be in time order",
      "5: error: speaker marker with no words after it",
    ]);
  });

  it("reports syntax errors at their line", async () => {
    expect(await lint("0:00:01.00|meta|{nope")).toEqual([
      '1: error: Invalid meta JSON on PSV line 1: "{nope"',
    ]);
  });
});

describe("checkChapters", () => {
  const segments = [
    {
      speaker: { kind: "unlabeled" as const },
      words: [0, 100, 200, 300].map((start) => ({ text: "w", start })),
    },
  ];
  const json = (chapters: object[]) =>
    JSON.stringify(
      {
        generation: {
          model: "m",
          prompt_version: "",
          reviewed_by_human: false,
        },
        chapters,
      },
      null,
      2,
    );
  const chapter = (start: string, end: string, bullets: string[] = []) => ({
    start,
    end,
    title: `${start}`,
    summary: "S.",
    bullets,
  });
  const check = async (content: string) =>
    (await checkChapters(content, "c.json", segments)).map(
      (i) => `${i.line}: ${i.severity}: ${i.message}`,
    );

  it("points at the offending chapter's line", async () => {
    expect(
      await check(
        json([
          chapter("0:00:00.00", "0:03:00.00"),
          chapter("0:02:00.00", "0:05:00.50"),
        ]),
      ),
    ).toEqual([
      '16: error: chapter 2 ("0:02:00.00") starts before the previous chapter ends',
    ]);
  });

  it("warns about uncovered speech and broken conventions", async () => {
    expect(
      await check(
        json([
          chapter("0:00:00.00", "0:00:30.00", ["a", "b"]),
          chapter("0:04:00.00", "0:05:00.50"),
        ]),
      ),
    ).toEqual([
      '9: warning: chapter 1 ("0:00:00.00") has 2 bullets; want 3–7, or 0–1 for a procedural chapter',
      '9: warning: chapter 1 ("0:00:00.00") runs 30s; a substantive chapter (2+ bullets) should run 60–900s',
      "9: warning: speech from 0:00:30.00 to 0:04:00.00 is in no chapter; extend a neighbouring chapter or add one",
    ]);
  });

  it("reports malformed JSON", async () => {
    expect((await check('{\n  "generation": ,\n}'))[0]).toMatch(
      /error: Unexpected/,
    );
  });
});
