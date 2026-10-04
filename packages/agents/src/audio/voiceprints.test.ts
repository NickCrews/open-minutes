import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeGrid, type Turn } from "./testdata/fake-voices";
import { similarity } from "./vectors";
import { HOP_SEC, speechIn, VoiceGrid, WINDOW_SEC } from "./voiceprints";

const turns: Turn[] = [
  { person: "alice", start: 0, end: 10 },
  // 3 s of silence
  { person: "bob", start: 13, end: 30 },
];

describe("speechIn", () => {
  const speech = [
    { start: 1, end: 2 },
    { start: 3, end: 5 },
    { start: 8, end: 9 },
  ];

  it("adds up the speech inside a range, clipped to it", () => {
    expect(speechIn(speech, 0, 10)).toBe(4);
    expect(speechIn(speech, 1.5, 4)).toBe(1.5);
    expect(speechIn(speech, 5, 8)).toBe(0);
    expect(speechIn(speech, 8.5, 20)).toBe(0.5);
    expect(speechIn([], 0, 10)).toBe(0);
  });
});

describe("VoiceGrid", () => {
  it("lays windows on a fixed grid that fits in the audio", () => {
    const { grid } = fakeGrid(turns, 30);
    expect(grid.size).toBe((30 - WINDOW_SEC) / HOP_SEC + 1);
    const windows = grid.windows(0.2, 2);
    expect(windows.map((w) => [w.start, w.end])).toEqual([
      [0.5, 2.5],
      [1, 3],
      [1.5, 3.5],
    ]);
    // The last window ends at the end of the audio.
    expect(grid.windows(25, 100).at(-1)!.end).toBe(30);
  });

  it("gives silent windows no voiceprint, and doesn't embed them", () => {
    const { grid, counter } = fakeGrid(turns, 30);
    const windows = grid.windows(9, 13);
    // [9, 11) is half silence; [10.5, 12.5) all silence; [12, 14) half.
    // Under 60% speech: 9-11 (1 s), ..., 12-14 (1 s). 12.5-14.5 has 1.5 s.
    expect(windows.map((w) => w.voiceprint !== null)).toEqual([
      ...Array(7).fill(false),
      true,
    ]);
    expect(counter.embedded).toBe(1);
  });

  it("embeds a window once, however often it's asked for", () => {
    const { grid, counter } = fakeGrid(turns, 30);
    grid.windows(0, 5);
    const first = counter.embedded;
    expect(first).toBe(10);
    grid.windows(0, 5);
    grid.voiceprint([{ start: 0, end: 7 }], 100);
    expect(counter.embedded).toBe(first + 1); // only 5-7 is new
  });

  it("caches windows on disk for the next grid over the same audio", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voice-grid-"));
    const a = fakeGrid(turns, 30, { cacheDir });
    const before = a.grid.windows(0, 30);
    expect(readdirSync(join(cacheDir, "voiceprints-v1"))).toEqual(["0.f32"]);

    const b = fakeGrid(turns, 30, { cacheDir, seed: 99 });
    const after = b.grid.windows(0, 30);
    expect(b.counter.embedded).toBe(0);
    expect(after.map((w) => w.voiceprint && [...w.voiceprint])).toEqual(
      before.map((w) => w.voiceprint && [...w.voiceprint]),
    );
  });

  it("caches only what was asked for, and fills in the rest later", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voice-grid-"));
    fakeGrid(turns, 30, { cacheDir }).grid.windows(0, 5);
    const b = fakeGrid(turns, 30, { cacheDir });
    b.grid.windows(0, 10);
    expect(b.counter.embedded).toBe(8); // 5-7, ..., 8.5-10.5
    expect(fakeGrid(turns, 30, { cacheDir }).grid.windows(0, 10)).toHaveLength(
      20,
    );
  });

  it("spreads a chunked cache over files", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voice-grid-"));
    const long: Turn[] = [{ person: "alice", start: 0, end: 200 }];
    const { grid } = fakeGrid(long, 200, { cacheDir });
    grid.windows(55, 65);
    expect(readdirSync(join(cacheDir, "voiceprints-v1")).sort()).toEqual([
      "0.f32",
      "1.f32",
    ]);
  });

  describe("voiceprint", () => {
    it("is the centroid of the voiced windows wholly inside the spans", () => {
      const { grid, voices } = fakeGrid(turns, 30);
      const alice = grid.voiceprint([{ start: 0, end: 10 }], 100)!;
      // 0-2, 0.5-2.5, ..., 8-10: 17 windows over 10 s.
      expect(alice.sampledSecs).toBe(10);
      expect(
        similarity(alice.voiceprint, voices.get("alice")!),
      ).toBeGreaterThan(0.95);
    });

    it("takes at most maxWindows, spread evenly through the spans", () => {
      const { grid, counter, voices } = fakeGrid(turns, 30);
      const v = grid.voiceprint(
        [
          { start: 0, end: 10 },
          { start: 13, end: 30 },
        ],
        4,
      )!;
      expect(v.sampledSecs).toBe(4 * WINDOW_SEC);
      expect(counter.embedded).toBe(4);
      // Two windows from each turn: both voices are in it.
      for (const person of ["alice", "bob"])
        expect(similarity(v.voiceprint, voices.get(person)!)).toBeGreaterThan(
          0.5,
        );
    });

    it("is null for a span shorter than a window, or silent", () => {
      const { grid } = fakeGrid(turns, 30);
      expect(grid.voiceprint([{ start: 2, end: 3.5 }], 10)).toBeNull();
      expect(grid.voiceprint([{ start: 10, end: 13 }], 10)).toBeNull();
      expect(grid.voiceprint([], 10)).toBeNull();
    });
  });

  it("refuses voiceprints of the wrong size", () => {
    const grid = new VoiceGrid({
      durationSecs: 10,
      speech: [{ start: 0, end: 10 }],
      cacheDir: null,
      embed: () => new Float32Array(3).fill(1),
    });
    expect(() => grid.windows(0, 1)).toThrow(/192-dimensional/);
  });
});

describe("VoiceGrid.voiceprint over overlapping spans", () => {
  it("counts each window once", () => {
    const { grid } = fakeGrid(turns, 30);
    const once = grid.voiceprint([{ start: 0, end: 6 }], 100)!;
    const twice = grid.voiceprint(
      [
        { start: 2, end: 6 },
        { start: 0, end: 6 },
      ],
      100,
    )!;
    expect(twice.sampledSecs).toBe(6);
    expect([...twice.voiceprint]).toEqual([...once.voiceprint]);
  });
});
