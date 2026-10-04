import { describe, expect, it } from "vitest";
import type { LabeledSegment } from "./meeting";
import {
  assembleTimeline,
  type Boundary,
  type Phrase,
  type TimelineInputs,
} from "./timeline";
import { timelineText } from "./timeline-text";
import { HOP_SEC, WINDOW_SEC } from "./voices";

/** A segment whose words fall `gap` seconds apart from `start`. */
function segment(
  id: number,
  label: string,
  start: number,
  text: string,
  gap = 0.4,
): LabeledSegment {
  const words = text
    .split(" ")
    .map((w, i) => ({ text: w, start: start + i * gap }));
  return { id, label, start, end: words.at(-1)!.start + 0.5, words };
}

/** A unit vector along axis `k`: two voices on different axes are unalike. */
const axis = (k: number) =>
  Float32Array.from({ length: 4 }, (_, i) => +(i === k));

/**
 * Voiceprint windows over [0, 30): `voiceAt(t)` says whose voice (an axis,
 * and the label it matches) the window starting at t hears.
 */
function windows(voiceAt: (t: number) => { k: number; label: string } | null) {
  const out: TimelineInputs["windows"][number][] = [];
  for (let t = 0; t + WINDOW_SEC <= 30; t += HOP_SEC) {
    const v = voiceAt(t + WINDOW_SEC / 2);
    out.push({
      start: t,
      end: t + WINDOW_SEC,
      embedding: v && axis(v.k),
      best: v && { label: v.label, similarity: 0.8 },
    });
  }
  return out;
}

const chair = { k: 0, label: "identified:chair" };
const member = { k: 1, label: "identified:member" };

describe("assembleTimeline", () => {
  // The chair talks 0-6 s; a member answers 7-9 s, but the transcript folds
  // the answer into the chair's segment; then the chair's next segment.
  const segments = [
    segment(0, chair.label, 0, "we will now take the roll call please answer"),
    segment(1, chair.label, 10, "thank you the motion carries"),
  ];
  segments[0]!.words.push(
    { text: "here", start: 7 },
    { text: "present", start: 7.6 },
  );
  segments[0]!.end = 8.1;
  const inputs: TimelineInputs = {
    from: 0,
    to: 14,
    segments,
    speech: [
      { start: 0, end: 4.2 },
      { start: 7, end: 8.3 },
      { start: 10, end: 12 },
      { start: 13.2, end: 14 }, // speech after the last word: untranscribed
    ],
    windows: windows((t) =>
      t < 4.5 ? chair : t < 7 ? null : t < 9 ? member : t < 10 ? null : chair,
    ),
    changes: [{ at: 6, similarity: 0.1 }],
    pitch: (from) => (from >= 6.5 && from < 9 ? 210 : 120),
  };
  const t = assembleTimeline(inputs);
  const phrases = t.items.filter((i): i is Phrase => i.kind === "phrase");
  const boundaries = t.items.filter(
    (i): i is Boundary => i.kind === "boundary",
  );

  it("cuts phrases at pauses and segment starts", () => {
    expect(phrases.map((p) => [p.start, p.segment, p.text])).toEqual([
      [0, 0, "we will now take the roll call please answer"],
      [7, 0, "here present"],
      [10, 1, "thank you the motion carries"],
    ]);
  });

  it("gives each phrase its pitch and voice", () => {
    expect(phrases.map((p) => [p.pitchHz, p.soundsLike?.label])).toEqual([
      [120, chair.label],
      [210, member.label],
      [120, chair.label],
    ]);
  });

  it("calls a change of speaker where the cues agree", () => {
    const [hidden, next] = boundaries;
    expect(hidden).toMatchObject({
      at: 7,
      segment: null,
      pitch: [120, 210],
      soundsLike: [chair.label, member.label],
      verdict: "change",
    });
    expect(hidden!.cues).toEqual(["voice", "pitch", "sounds like"]);
    expect(hidden!.pauseSecs).toBeCloseTo(7 - 4.2);
    expect(next).toMatchObject({
      at: 10,
      segment: { id: 1, label: chair.label },
      verdict: "change",
    });
  });

  it("finds speech with no words under it", () => {
    expect(t.items.at(-1)).toMatchObject({
      kind: "untranscribed",
      start: 13.2,
      end: 14,
    });
  });

  it("writes it out in time order, flagging the hidden turn", () => {
    const text = timelineText({ meeting: "m", focus: null, ...t });
    const lines = text.split("\n");
    const body = lines.slice(lines.indexOf("── seg 0 identified:chair ──"));
    expect(body[1]).toBe(
      "0:00:00.00  120 Hz  identified:chair 0.80  | we will now take the roll call please answer",
    );
    expect(body[2]).toBe(
      "▲ 0:00:07.00 likely change of speaker, inside a segment: voice 0.00 · pitch 120→210 Hz · sounds like identified:chair→identified:member · pause 2.80 s",
    );
    expect(body[3]).toContain("≠ identified:member 0.80  | here present");
    expect(body[4]).toMatch(/^── seg 1 identified:chair ── 0:00:10.00 {2}▲ /);
    expect(text).toContain(
      "Likely changes of speaker inside a segment: 0:00:07.00.",
    );
    expect(text).toContain("⚠ 0:00:13.20-0:00:14.00 0.8 s of speech, no words");
  });
});
