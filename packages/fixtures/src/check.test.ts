import { describe, expect, it } from "vitest";
import {
  checkChapters,
  checkFixtures,
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

const lint = (content: string) =>
  checkPsv(content, "t.psv").map(
    (i) => `${i.line}: ${i.severity}: ${i.message}`,
  );

describe("all fixtures", () => {
  it("pass every check", () => {
    // Fix these at the file:line given, or run `pnpm fixtures:check`.
    expect(checkFixtures().map((i) => formatIssue(i))).toEqual([]);
  });

  it("include chapters for at least one golden meeting", () => {
    expect(loadAllTestData().meetings.some((m) => m.chapters)).toBe(true);
    expect(meetingDirs().length).toBeGreaterThan(0);
  });
});

describe("checkPsv", () => {
  it("accepts a well-formed transcript", () => {
    expect(
      lint(
        psv(
          ["0:00:01.00", "@identified:kyle-kelly"],
          ["0:00:01.00", "Hello."],
          ["0:00:02.00", "@segmented:spk-1"],
          ["0:00:02.00", "Hi."],
        ),
      ),
    ).toEqual([]);
  });

  it("catches a speaker marker inserted a line off", () => {
    expect(
      lint(
        psv(
          ["0:00:01.00", "@identified:kyle-kelly"],
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

  it("catches words out of order and empty speakers", () => {
    expect(
      lint(
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

  it("reports syntax errors at their line", () => {
    expect(lint("0:00:01.00|meta|{nope")).toEqual([
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
  const check = (content: string) =>
    checkChapters(content, "c.json", segments).map(
      (i) => `${i.line}: ${i.severity}: ${i.message}`,
    );

  it("points at the offending chapter's line", () => {
    expect(
      check(
        json([
          chapter("0:00:00.00", "0:03:00.00"),
          chapter("0:02:00.00", "0:05:00.50"),
        ]),
      ),
    ).toEqual([
      '16: error: chapter 2 ("0:02:00.00") starts before the previous chapter ends',
    ]);
  });

  it("warns about uncovered speech and broken conventions", () => {
    expect(
      check(
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

  it("reports malformed JSON", () => {
    expect(check('{\n  "generation": ,\n}')[0]).toMatch(/error: Unexpected/);
  });
});
