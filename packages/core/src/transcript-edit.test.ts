import { describe, expect, it } from "vite-plus/test";
import { applyEdits, EditError } from "./transcript-edit";
import type { Segment, Speaker } from "./transcript";

const person = (p: string): Speaker<string> => ({
  speakerNumber: null,
  person: p,
});
const spk = (n: number): Speaker<string> => ({
  speakerNumber: n,
  person: null,
});

/** A segment from "text@onset" words. */
function seg(speaker: Speaker<string>, ...words: string[]): Segment<string> {
  return {
    ...speaker,
    words: words.map((w) => {
      const [text, start] = w.split("@");
      return { text: text!, start: Number(start) };
    }),
  };
}

const chair = person("chair");
const meeting = [
  seg(chair, "Thank@1", "you.@1.5", "Kyle.@2", "I@3", "agree.@3.5"),
  seg(spk(2), "Second.@5"),
  seg(chair, "Good@7", "wood@7.5", "is@8", "great.@8.5"),
];

describe("applyEdits", () => {
  it("splits a segment at a word, giving the rest a new speaker", () => {
    const { segments } = applyEdits(meeting, [
      { op: "split", at: 3, word: "I", speaker: person("kyle") },
    ]);
    expect(segments.map((s) => [s.person, s.words.length])).toEqual([
      ["chair", 3],
      ["kyle", 2],
      [null, 1],
      ["chair", 4],
    ]);
  });

  it("relabels a whole segment when the split word starts it", () => {
    const { segments } = applyEdits(meeting, [
      { op: "split", at: 5, speaker: person("kyle") },
    ]);
    expect(segments[1]).toMatchObject({ person: "kyle", speakerNumber: null });
  });

  it("merges neighbours left with the same speaker", () => {
    const { segments } = applyEdits(meeting, [
      { op: "label", at: 5, speaker: chair },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.words).toHaveLength(10);
  });

  it("replaces words, keeping their onsets", () => {
    const { segments } = applyEdits(meeting, [
      { op: "replace", at: 7, old: "Good wood", new: "Girdwood" },
    ]);
    expect(segments[2]!.words.slice(0, 2)).toEqual([
      { text: "Girdwood", start: 7 },
      { text: "is", start: 8 },
    ]);
  });

  it("refuses a replace whose words don't match", () => {
    expect(() =>
      applyEdits(meeting, [
        { op: "replace", at: 7, old: "Bad wood", new: "Girdwood" },
      ]),
    ).toThrow(EditError);
  });

  it("inserts a turn and gives the words after it back", () => {
    const { segments } = applyEdits(meeting, [
      {
        op: "insert",
        words: [{ text: "Yes.", start: 2.5 }],
        speaker: person("kyle"),
      },
    ]);
    expect(segments.map((s) => s.person)).toEqual([
      "chair",
      "kyle",
      "chair",
      null,
      "chair",
    ]);
  });

  it("inserts a word into the segment it falls in", () => {
    const { segments } = applyEdits(meeting, [
      { op: "insert", words: [{ text: "very", start: 8.2 }] },
    ]);
    expect(segments[2]!.words.map((w) => w.text)).toEqual([
      "Good",
      "wood",
      "is",
      "very",
      "great.",
    ]);
  });

  it("refuses to insert at an onset a word already has", () => {
    expect(() =>
      applyEdits(meeting, [
        { op: "insert", words: [{ text: "very", start: 8 }] },
      ]),
    ).toThrow(/already starts at 0:00:08.00/);
  });

  it("replaces every occurrence, keeping trailing punctuation", () => {
    const { segments, notes } = applyEdits(meeting, [
      { op: "replace_all", old: "kyle", new: "Kyle Kelley" },
    ]);
    expect(segments[0]!.words.map((w) => w.text)).toEqual([
      "Thank",
      "you.",
      "Kyle",
      "Kelley.",
      "I",
      "agree.",
    ]);
    expect(notes).toEqual(['replace_all "kyle" -> "Kyle Kelley": 1']);
  });

  it("says which op failed, and what words are near", () => {
    expect(() =>
      applyEdits(meeting, [
        { op: "label", at: 1, speaker: chair },
        { op: "label", at: 6, speaker: chair },
      ]),
    ).toThrow(/^op 2: no word at 0:00:06.00; nearby: 0:00:03.50=agree./);
  });

  it("leaves the segments it was given alone", () => {
    const before = JSON.stringify(meeting);
    applyEdits(meeting, [
      { op: "replace", at: 7, old: "Good wood", new: "Girdwood" },
    ]);
    expect(JSON.stringify(meeting)).toBe(before);
  });
});
