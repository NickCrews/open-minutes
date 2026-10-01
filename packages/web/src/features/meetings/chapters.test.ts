import { describe, expect, test } from "vitest";
import {
  chapterAnchors,
  chapterSpeakers,
  meetingLink,
  scrubberParts,
} from "./chapters";
import type { Segment } from "./speaker-identity";

/** A segment by `speaker` (a speaker number) with one word per onset. */
function segment(speaker: number, ...onsets: number[]): Segment {
  return {
    id: 0,
    meeting_id: 1,
    person_id: null,
    person: null,
    speaker_number: speaker,
    start_secs: null,
    end_secs: null,
    duration_secs: null,
    created_at: new Date(0),
    words: onsets.map((start) => ({ text: "w", start })),
  } as Segment;
}

describe("chapterSpeakers", () => {
  test("clips segments to each chapter and ranks speakers by time", () => {
    const segments = [segment(1, 0, 9.5), segment(2, 10, 29.5)];
    const [first, second] = chapterSpeakers(
      [
        { start: 0, end: 15 },
        { start: 15, end: 40 },
      ],
      segments,
    );
    expect(first!.map((s) => [s.label, s.secs])).toEqual([
      ["Anonymous Aardvark", 10],
      ["Anonymous Beaver", 5],
    ]);
    expect(second!.map((s) => [s.label, s.secs])).toEqual([
      ["Anonymous Beaver", 15],
    ]);
  });

  test("gives a chapter with no speech no speakers", () => {
    expect(chapterSpeakers([{ start: 50, end: 60 }], [segment(1, 0)])).toEqual([
      [],
    ]);
  });
});

describe("chapterAnchors", () => {
  const segments = [segment(1, 0, 5, 10), segment(2, 20, 25)];

  test("anchors a chapter at a segment start before that segment", () => {
    expect(chapterAnchors([{ start: 0 }, { start: 15 }], segments)).toEqual(
      new Map([
        [0, [{ chapter: 0, word: 0 }]],
        [1, [{ chapter: 1, word: 0 }]],
      ]),
    );
  });

  test("splits a segment where a chapter starts mid-turn", () => {
    expect(chapterAnchors([{ start: 4 }, { start: 24 }], segments)).toEqual(
      new Map([
        [0, [{ chapter: 0, word: 1 }]],
        [1, [{ chapter: 1, word: 1 }]],
      ]),
    );
  });

  test("skips a chapter that starts after the last word", () => {
    expect(chapterAnchors([{ start: 99 }], segments)).toEqual(new Map());
  });
});

describe("scrubberParts", () => {
  test("fills uncovered time with gaps", () => {
    expect(
      scrubberParts(
        [
          { start: 5, end: 10 },
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        50,
      ),
    ).toEqual([
      { kind: "gap", start: 0, end: 5 },
      { kind: "chapter", chapter: 0, start: 5, end: 10 },
      { kind: "chapter", chapter: 1, start: 10, end: 20 },
      { kind: "gap", start: 20, end: 30 },
      { kind: "chapter", chapter: 2, start: 30, end: 40 },
      { kind: "gap", start: 40, end: 50 },
    ]);
  });

  test("is one plain stretch with no chapters", () => {
    expect(scrubberParts([], 50)).toEqual([{ kind: "gap", start: 0, end: 50 }]);
  });

  test("clips chapters that run past the video", () => {
    expect(scrubberParts([{ start: 0, end: 60 }], 50)).toEqual([
      { kind: "chapter", chapter: 0, start: 0, end: 50 },
    ]);
  });
});

test("meetingLink rounds down to whole seconds", () => {
  expect(meetingLink("https://x.org", 3, 754.81)).toBe(
    "https://x.org/meetings/3?t=754",
  );
});
