import { describe, expect, it } from "vitest";
import type { LabeledSegment } from "./meeting";
import {
  alikePairs,
  auditLabel,
  labelVoices,
  ONE_VOICE,
  references,
  referencesWithout,
  SAME_PERSON,
} from "./speakers";
import { fakeGrid, type Turn } from "./testdata/voices";
import { similarity } from "./vectors";

/** A segment of one word every 0.4 s from `start` to `end`. */
function segment(
  id: number,
  label: string,
  start: number,
  end: number,
): LabeledSegment {
  const words = [];
  for (let t = start; t < end - 0.4; t += 0.4)
    words.push({ start: t, text: "w" });
  return { id, label, start, end, words };
}

// Who really spoke, and how the transcript labels it: the diarizer folded
// carol into alice's label, split bob over two labels, and dave says one
// short thing.
const meeting: [Turn, string][] = [
  [{ person: "alice", start: 0, end: 30 }, "A"],
  [{ person: "bob", start: 30, end: 60 }, "B"],
  [{ person: "carol", start: 60, end: 75 }, "A"],
  [{ person: "alice", start: 75, end: 100 }, "A"],
  [{ person: "dave", start: 100, end: 104 }, "spk-9"],
  [{ person: "bob", start: 104, end: 130 }, "spk-2"],
  [{ person: "alice", start: 130, end: 140 }, "unattributed"],
];
const turns = meeting.map(([t]) => t);
const segments = meeting.map(([t, label], id) =>
  segment(id, label, t.start, t.end),
);
const world = () => fakeGrid(turns, 140);

describe("labelVoices", () => {
  it("gives each speaker label a voiceprint, sampled from its segments", () => {
    const { grid, voices } = world();
    const all = labelVoices(grid, segments);
    expect(all.map((v) => v.label)).toEqual(["A", "B", "spk-9", "spk-2"]);
    const b = all.find((v) => v.label === "B")!;
    expect(b.sampledSecs).toBeGreaterThan(25);
    expect(similarity(b.voiceprint, voices.get("bob")!)).toBeGreaterThan(0.95);
    // A's voiceprint sits between alice and carol.
    const a = all.find((v) => v.label === "A")!;
    expect(similarity(a.voiceprint, voices.get("alice")!)).toBeGreaterThan(0.8);
    expect(similarity(a.voiceprint, voices.get("carol")!)).toBeGreaterThan(0.2);
  });

  it("keeps only labels with enough speech as references", () => {
    const { grid } = world();
    expect(references(labelVoices(grid, segments)).map((v) => v.label)).toEqual(
      ["A", "B", "spk-2"],
    );
  });
});

describe("auditLabel", () => {
  it("finds two voices under a label, and the segment that isn't its voice", () => {
    const { grid } = world();
    const audit = auditLabel(grid, segments, "A");
    expect(audit.verdict).toBe("more than one voice");
    expect(audit.segments).toBe(3);
    expect(audit.split!.similarity).toBeLessThan(ONE_VOICE);
    expect(audit.split!.groups.map((g) => [g.segments, g.secs])).toEqual([
      [2, expect.closeTo(55, 0)],
      [1, expect.closeTo(15, 0)],
    ]);
    expect(
      audit.measured.filter((m) => m.suspect).map((m) => m.segment.id),
    ).toEqual([2]);
  });

  it("can't split a label with one segment", () => {
    const { grid } = world();
    const audit = auditLabel(grid, segments, "B");
    expect(audit.verdict).toBe("too few segments to tell");
    expect(audit.split).toBeNull();
    expect(audit.measured).toHaveLength(1);
    expect(audit.measured[0]!.suspect).toBe(false);
  });

  it("splits a one-person label into two alike halves", () => {
    const { grid } = world();
    const twoBobs = segments.map((s) =>
      s.label === "spk-2" ? { ...s, label: "B" } : s,
    );
    const audit = auditLabel(grid, twoBobs, "B");
    expect(audit.verdict).toBe("one voice");
    expect(audit.split!.similarity).toBeGreaterThan(SAME_PERSON);
    expect(audit.measured.every((m) => !m.suspect)).toBe(true);
  });

  it("flags a segment that sounds like another label", () => {
    const { grid } = world();
    // One of bob's segments, labelled A.
    const misfiled = segments.map((s) =>
      s.id === 5 ? { ...s, label: "A" } : s,
    );
    const audit = auditLabel(grid, misfiled, "A");
    const bob = audit.measured.find((m) => m.segment.id === 5)!;
    expect(bob.suspect).toBe(true);
    expect(bob.soundsLike[0]).toMatchObject({ label: "B" });
    expect(bob.soundsLike[0]!.similarity).toBeGreaterThan(SAME_PERSON);
  });
});

describe("alikePairs", () => {
  it("finds two labels for one voice", () => {
    const { grid } = world();
    const pairs = alikePairs(labelVoices(grid, segments), 0.7);
    expect(pairs).toEqual([
      { a: "B", b: "spk-2", similarity: expect.any(Number) as number },
    ]);
    expect(pairs[0]!.similarity).toBeGreaterThan(SAME_PERSON);
  });
});

describe("referencesWithout", () => {
  it("samples a segment's label from its other segments", () => {
    const { grid, voices: people } = world();
    const voices = labelVoices(grid, segments);
    // spk-2 is all segment 5, so without it spk-2 is no reference.
    expect(
      referencesWithout(grid, segments, voices, segments[5]!).map(
        (v) => v.label,
      ),
    ).toEqual(["A", "B"]);
    // A without carol's segment is just alice.
    const a = referencesWithout(grid, segments, voices, segments[2]!).find(
      (v) => v.label === "A",
    )!;
    expect(similarity(a.voiceprint, people.get("alice")!)).toBeGreaterThan(
      0.95,
    );
  });
});
