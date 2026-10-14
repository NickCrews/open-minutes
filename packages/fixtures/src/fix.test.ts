import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixGoldenSegments, fixMeetingDir, serializeChapters } from "./fix";
import { meetingDirs } from "./check";
import { getMeetingData, transcriptPath } from "./test-data";

const slugOf = (dir: string) => dir.split(/[\\/]/).at(-1)!;

/** A golden meeting with chapters. */
const withChapters = meetingDirs().find(
  (dir) => getMeetingData(slugOf(dir)).chapters,
)!;

describe("fixGoldenSegments", () => {
  it("cleans each speaker separately and drops emptied segments", async () => {
    const { segments, fixed } = await fixGoldenSegments([
      {
        speaker: { kind: "identified", person: "a" },
        words: [{ text: "Um.", start: 1 }],
      },
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [
          { text: "Uh,", start: 2 },
          { text: "the", start: 2.2 },
          { text: "the", start: 2.4 },
          { text: "budget.", start: 2.6 },
        ],
      },
    ]);
    expect(segments).toEqual([
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [
          { text: "The", start: 2.4 },
          { text: "budget.", start: 2.6 },
        ],
      },
    ]);
    expect(fixed.map((v) => v.code)).toEqual([
      "unclean-word",
      "unclean-word",
      "unclean-word",
    ]);
  });

  it("returns clean segments as given", async () => {
    const given = [
      {
        speaker: { kind: "unlabeled" } as const,
        words: [{ text: "Yes.", start: 1 }],
      },
    ];
    expect(await fixGoldenSegments(given)).toEqual({
      segments: given,
      fixed: [],
    });
    expect((await fixGoldenSegments(given)).segments).toBe(given);
  });
});

describe("fixMeetingDir", () => {
  /** A copy of a meeting with chapters, under a fresh data root. */
  function copyMeeting(): string {
    const dir = join(
      mkdtempSync(join(tmpdir(), "fix-")),
      "meetings",
      slugOf(withChapters),
    );
    cpSync(withChapters, dir, { recursive: true });
    return dir;
  }

  it("leaves a clean meeting's files alone", async () => {
    expect(await fixMeetingDir(copyMeeting())).toEqual([]);
  });

  it("fixes the transcript and chapters.json", async () => {
    const dir = copyMeeting();
    const psv = transcriptPath(dir)!;
    const lines = readFileSync(psv, "utf8").split("\n");
    const word = lines.findIndex((l) => l.includes("|text|"));
    lines.splice(word, 0, lines[word]!.replace(/\|text\|.*/, "|text|Um,"));
    writeFileSync(psv, lines.join("\n"));
    const chaptersFile = join(dir, "chapters.json");
    const chapters = readFileSync(chaptersFile, "utf8");
    writeFileSync(chaptersFile, chapters.replace(/"title": "/, '"title": "–'));

    const rewritten = await fixMeetingDir(dir);
    expect(rewritten.map((r) => [r.file, r.fixed.map((v) => v.code)])).toEqual([
      [psv, ["unclean-word"]],
      [chaptersFile, ["invalid-chapter"]],
    ]);
    expect(readFileSync(psv, "utf8")).toBe(
      readFileSync(transcriptPath(withChapters)!, "utf8"),
    );
    expect(readFileSync(chaptersFile, "utf8")).toBe(
      chapters.replace(/"title": "/, '"title": "-'),
    );
  });
});

describe("serializeChapters", () => {
  it("writes chapters.json as it reads", () => {
    const { chapters } = getMeetingData(slugOf(withChapters));
    expect(serializeChapters(chapters!)).toBe(
      readFileSync(join(withChapters, "chapters.json"), "utf8"),
    );
  });
});
