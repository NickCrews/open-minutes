import { describe, expect, it } from "vitest";
import type { LabeledSegment } from "./meeting";
import { fakeGrid, type Turn } from "./testdata/fake-voices";
import {
  buildTimeline,
  changePoints,
  type Cut,
  type Passage,
  SAME_VOICE,
  type TimelineItem,
  type Untranscribed,
  VOICE_CHANGE,
  voiceAcross,
} from "./timeline";

/** A segment of one word every 0.4 s from `start` to before `end`. */
function segment(
  id: number,
  label: string,
  start: number,
  end: number,
): LabeledSegment {
  const words = [];
  for (let k = 0; start + k * 0.4 < end - 1e-9; k++)
    words.push({
      start: Math.round((start + k * 0.4) * 100) / 100,
      text: `w${k}`,
    });
  return { id, label, start, end, words };
}

// Who really spoke when...
const turns: Turn[] = [
  { person: "alice", start: 0, end: 10 },
  { person: "bob", start: 10, end: 24 }, // no pause after alice
  { person: "carol", start: 25, end: 32 },
  { person: "dave", start: 33, end: 37 }, // no words in the transcript
  { person: "carol", start: 38, end: 45 },
];
// ...and what the transcript says: segment 0 runs on into bob's turn, and
// segment 1 starts a new label partway through it.
const segments = [
  segment(0, "A", 0, 15),
  segment(1, "B", 15.2, 22.8),
  segment(2, "C", 25, 32),
  segment(3, "C", 38, 45),
];

function timeline(from = 0, to = 45) {
  const { grid } = fakeGrid(turns, 45);
  // A low voice before 25 s, a high one after.
  const pitch = (a: number) => (a < 25 ? 110 : 220);
  return buildTimeline({ from, to, segments, grid, pitch });
}

const cuts = (items: TimelineItem[]) =>
  items.filter((i): i is Cut => i.type === "cut");
const passages = (items: TimelineItem[]) =>
  items.filter((i): i is Passage => i.type === "passage");
const cutAt = (items: TimelineItem[], at: number) =>
  cuts(items).find((c) => Math.abs(c.at - at) < 0.01);

describe("buildTimeline", () => {
  it("cuts a segment where the voice changes, and flags the missed turn", () => {
    const { items } = timeline();
    const c = cutAt(items, 10)!;
    expect(c).toMatchObject({
      newSegment: null,
      finding: "voice changes, label doesn't",
    });
    expect(c.voiceSimilarity!).toBeLessThan(VOICE_CHANGE);
  });

  it("flags a new label where the voice carries on", () => {
    const c = cutAt(timeline().items, 15.2)!;
    expect(c.newSegment!.id).toBe(1);
    expect(c.voiceSimilarity!).toBeGreaterThanOrEqual(SAME_VOICE);
    expect(c.finding).toBe("label changes, voice doesn't");
  });

  it("finds nothing wrong with a new speaker under a new label", () => {
    const c = cutAt(timeline().items, 25)!;
    expect(c.newSegment!.id).toBe(2);
    expect(c.pauseSecs).toBeCloseTo(1);
    expect(c.voiceSimilarity!).toBeLessThan(VOICE_CHANGE);
    expect(c.finding).toBeNull();
  });

  it("cuts only at new segments and changes of voice", () => {
    expect(cuts(timeline().items).map((c) => c.at)).toEqual([10, 15.2, 25, 38]);
  });

  it("doesn't cut one voice at a pause", () => {
    const paused = fakeGrid(
      [
        { person: "alice", start: 0, end: 4.1 },
        { person: "alice", start: 4.9, end: 9 },
      ],
      10,
    );
    const { items } = buildTimeline({
      from: 0,
      to: 10,
      segments: [segment(0, "A", 0, 9)],
      grid: paused.grid,
      pitch: () => null,
    });
    expect(items.map((i) => i.type)).toEqual(["passage"]);
  });

  it("moves a change of voice to the longest pause near it", () => {
    // Alice stops at 8.6 and bob starts at 8.8. The windows put the change
    // at 9.0, nearest the word at 9.05, but the pause puts it at 8.8.
    const { grid } = fakeGrid(
      [
        { person: "alice", start: 0, end: 8.6 },
        { person: "bob", start: 8.8, end: 20 },
      ],
      20,
    );
    const onsets = [...segment(0, "A", 0, 8.4).words.map((w) => w.start)];
    onsets.push(8.8, 9.05, 9.3, 9.6, 10, 12, 14, 16, 18);
    const words = onsets.map((start) => ({ start, text: "w" }));
    const { items } = buildTimeline({
      from: 0,
      to: 20,
      segments: [{ id: 0, label: "A", start: 0, end: 18.5, words }],
      grid,
      pitch: () => null,
    });
    expect(cuts(items).map((c) => [c.at, c.pauseSecs])).toEqual([
      [8.8, expect.closeTo(0.2)],
    ]);
  });

  it("doesn't cut a segment for a change of voice its words don't confirm", () => {
    // Bob talks right after alice's last words, with no words of his own.
    const { grid } = fakeGrid(
      [
        { person: "alice", start: 0, end: 10 },
        { person: "bob", start: 10.4, end: 20 },
      ],
      20,
    );
    const { items } = buildTimeline({
      from: 0,
      to: 20,
      segments: [segment(0, "A", 0, 10)],
      grid,
      pitch: () => null,
    });
    expect(items.map((i) => i.type)).toEqual(["passage", "untranscribed"]);
  });

  it("can't tell the voice either side of a passage under 2 s", () => {
    const { grid } = fakeGrid(
      [
        { person: "alice", start: 0, end: 10 },
        { person: "bob", start: 10, end: 11.5 },
        { person: "alice", start: 11.5, end: 20 },
      ],
      20,
    );
    const { items } = buildTimeline({
      from: 0,
      to: 20,
      segments: [
        segment(0, "A", 0, 10),
        segment(1, "B", 10, 11.5),
        segment(2, "A", 11.6, 20),
      ],
      grid,
      pitch: () => null,
    });
    expect(cuts(items).map((c) => [c.at, c.voiceSimilarity])).toEqual([
      [10, null],
      [11.6, null],
    ]);
  });

  it("gives each passage its words, pitch and the labels its voice is like", () => {
    const ps = passages(timeline().items);
    expect(ps[0]).toMatchObject({
      start: 0,
      segment: { id: 0 },
      text: expect.stringMatching(/^w0 w1 w2 /) as string,
      pitchHz: 110,
    });
    // Bob's words under segment 0 sound like B, bob's label.
    const bobInA = ps.find((p) => p.start === 10)!;
    expect(bobInA.segment.id).toBe(0);
    expect(bobInA.soundsLike[0]!.label).toBe("B");
    const carol = ps.find((p) => p.start === 38)!;
    expect(carol).toMatchObject({ pitchHz: 220, ownLabelRanked: true });
    expect(carol.soundsLike.map((m) => m.label)).toEqual(["C", "A", "B"]);
  });

  it("leaves a passage's segment out of its own label's voice", () => {
    // A is all segment 0, so segment 0 can't vouch for A.
    const inA = passages(timeline().items).filter((p) => p.segment.id === 0);
    expect(inA).toHaveLength(2);
    for (const p of inA) {
      expect(p.ownLabelRanked).toBe(false);
      expect(p.soundsLike.map((m) => m.label)).not.toContain("A");
    }
    // Carol filed under alice's label: A without her segment is just alice.
    const { grid } = fakeGrid(
      [
        { person: "alice", start: 0, end: 10 },
        { person: "carol", start: 11, end: 20 },
        { person: "alice", start: 21, end: 30 },
      ],
      30,
    );
    const { items } = buildTimeline({
      from: 0,
      to: 30,
      segments: [
        segment(0, "A", 0, 10),
        segment(1, "A", 11, 20),
        segment(2, "A", 21, 30),
      ],
      grid,
      pitch: () => null,
    });
    const carol = passages(items).find((p) => p.segment.id === 1)!;
    expect(carol.ownLabelRanked).toBe(true);
    expect(carol.soundsLike[0]!.similarity).toBeLessThan(0.5);
    const alice = passages(items).find((p) => p.segment.id === 2)!;
    expect(alice.soundsLike[0]!.similarity).toBeGreaterThan(0.5);
  });

  it("shows speech with no words, and that it's no one's voice", () => {
    const gaps = timeline().items.filter(
      (i): i is Untranscribed => i.type === "untranscribed",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      start: expect.closeTo(33, 0),
      end: expect.closeTo(37, 0),
      pitchHz: 220,
    });
    expect(gaps[0]!.speechSecs).toBeGreaterThan(3);
    expect(gaps[0]!.soundsLike[0]!.similarity).toBeLessThan(0.5);
  });

  it("lists items in time order, each cut just before its passage", () => {
    const { items } = timeline();
    const times = items.map((i) => (i.type === "cut" ? i.at : i.start));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    items.forEach((item, i) => {
      if (item.type === "cut")
        expect(items[i + 1]).toMatchObject({
          type: "passage",
          start: item.at,
        });
    });
    expect(items[0]!.type).toBe("passage");
  });

  it("covers only words in range, but matches against the whole meeting", () => {
    const t = timeline(26, 31);
    expect(passages(t.items).every((p) => p.segment.id === 2)).toBe(true);
    expect(t.references).toEqual(["A", "B", "C"]);
  });

  it("is empty where nobody talks", () => {
    expect(timeline(32.1, 32.9).items).toEqual([]);
  });
});

describe("changePoints", () => {
  it("finds the one moment the voice changes", () => {
    const { grid } = fakeGrid(turns, 45);
    const changes = changePoints(grid.windows(0, 24));
    expect(changes.map((c) => c.at)).toEqual([10]);
  });

  it("finds a change across a pause once", () => {
    const { grid } = fakeGrid(turns, 45);
    const changes = changePoints(grid.windows(18, 31));
    expect(changes).toHaveLength(1);
    // Bob stops at 24 and carol starts at 25, but a 2 s window only places
    // a change to within a second or so.
    expect(changes[0]!.at).toBeGreaterThanOrEqual(23);
    expect(changes[0]!.at).toBeLessThanOrEqual(26);
  });

  it("finds none in one voice", () => {
    const { grid } = fakeGrid(turns, 45);
    expect(changePoints(grid.windows(0, 8))).toEqual([]);
  });
});

describe("voiceAcross", () => {
  it("bridges a pause, but not silence beyond reach", () => {
    const { grid } = fakeGrid(turns, 45);
    const windows = grid.windows(0, 45);
    expect(voiceAcross(windows, 5)!).toBeGreaterThan(SAME_VOICE);
    expect(voiceAcross(windows, 24.5)!).toBeLessThan(VOICE_CHANGE);
    expect(voiceAcross(grid.windows(0, 45), 60)).toBeNull();
  });
});
