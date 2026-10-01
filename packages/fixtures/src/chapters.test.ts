import { describe, expect, it } from "vitest";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import {
  chapterErrors,
  chapterWarnings,
  uncoveredSpeech,
} from "@open-minutes/core/chapters";
import { loadAllTestData, parseGoldenChapters } from "./test-data";

// The chapter rules in docs/chapters.md, checked against every golden meeting
// that has chapters. If a rule fails on real chapters, revisit the rule.
const chaptered = loadAllTestData().meetings.filter((m) => m.chapters);

describe("golden chapters", () => {
  it("exist for at least one golden meeting", () => {
    expect(chaptered.length).toBeGreaterThan(0);
  });

  describe.each(chaptered.map((m) => [m.youtube_id, m] as const))(
    "%s",
    (_, meeting) => {
      const chapters = meeting.chapters!.chapters;
      const speech = meeting.segments
        .filter((s) => s.words.length > 0)
        .map((s) => ({
          start: s.words[0]!.start,
          end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
        }));
      const speechEnd = Math.max(...speech.map((s) => s.end));

      it("are ordered, non-overlapping and within the meeting", () => {
        expect(chapterErrors(chapters, speechEnd)).toEqual([]);
      });

      it("cover every stretch of speech", () => {
        expect(uncoveredSpeech(speech, chapters)).toEqual([]);
      });

      it("keep substantive chapters to 1–15 minutes and 3–7 bullets", () => {
        expect(chapterWarnings(chapters)).toEqual([]);
      });
    },
  );
});

describe("parseGoldenChapters", () => {
  const valid = {
    generation: { model: "human", prompt_version: "", reviewed_by_human: true },
    chapters: [
      {
        start: "0:00:01.50",
        end: "1:00:00.00",
        title: "All of it",
        summary: "Everything happened.",
        bullets: [],
      },
    ],
  };

  it("converts times to seconds", () => {
    expect(parseGoldenChapters(valid, "c.json").chapters[0]).toMatchObject({
      start: 1.5,
      end: 3600,
    });
  });

  it("rejects a malformed file, naming the field", () => {
    expect(() =>
      parseGoldenChapters(
        { ...valid, chapters: [{ ...valid.chapters[0], bullets: "x" }] },
        "c.json",
      ),
    ).toThrow(/c.json: chapters\[0\].bullets/);
    expect(() => parseGoldenChapters({ chapters: [] }, "c.json")).toThrow(
      /missing generation/,
    );
  });
});
