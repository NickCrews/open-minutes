import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { fixGoldenSegments, serializeChapters } from "./fix";
import { meetingDirs } from "./check";
import { getMeetingData } from "./datums";

const slugOf = (dir: string) => dir.split(/[\\/]/).at(-1)!;

/** A golden meeting with chapters. */
const withChapters = meetingDirs().find(
  (dir) => getMeetingData(slugOf(dir)).chapters,
)!;

describe("fixGoldenSegments", () => {
  it("cleans each speaker separately and drops emptied segments", async () => {
    const { segments, fixed } = await fixGoldenSegments([
      {
        speakerNumber: null,
        person: "a",
        words: [{ text: "Um.", start: 1 }],
      },
      {
        speakerNumber: 2,
        person: null,
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
        speakerNumber: 2,
        person: null,
        words: [
          { text: "The", start: 2.4 },
          { text: "budget.", start: 2.6 },
        ],
      },
    ]);
    expect(fixed.map((v) => v.code)).toEqual([
      "filler-word",
      "filler-word",
      "stutter",
      "empty-segment",
    ]);
  });

  it("leaves an answer moved out of the asker's segment unattributed", async () => {
    const clerk = { speakerNumber: null, person: "clerk" };
    const { segments } = await fixGoldenSegments([
      {
        ...clerk,
        words: [
          { text: "Member", start: 1 },
          { text: "Johnson.", start: 1.3 },
          { text: "Yes.", start: 2 },
        ],
      },
    ]);
    expect(segments).toEqual([
      {
        ...clerk,
        words: [
          { text: "Member", start: 1 },
          { text: "Johnson.", start: 1.3 },
        ],
      },
      {
        speakerNumber: null,
        person: null,
        words: [{ text: "Yes.", start: 2 }],
      },
    ]);
  });

  it("returns clean segments as given", async () => {
    const given = [
      {
        speakerNumber: null,
        person: null,
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

describe("serializeChapters", () => {
  it("writes chapters.json as it reads", () => {
    const { chapters } = getMeetingData(slugOf(withChapters));
    expect(serializeChapters(chapters!)).toBe(
      readFileSync(join(withChapters, "chapters.json"), "utf8"),
    );
  });
});
