// What the Parakeet recognizer does, measured on a real meeting.
//
// THESE TESTS ARE NOT REQUIREMENTS (see README.md in this directory). They
// pin down how the model behaves, so nobody has to measure it again, and so
// a model upgrade that changes something is noticed. They are about the
// model alone, not about any code that uses it.
//
// Every test decodes stretches of gbos-2026-06-15, each in one Parakeet
// pass, and scores them against the hand-corrected golden, logging what it
// measures. Bounds are wide on purpose: a test here fails when the model's
// behaviour changes in kind, not by a point.

import { beforeAll, describe, expect, it } from "vitest";
import { transcribeRange } from "@open-minutes/audio/transcribe";
import { readWave, type WaveForm } from "@open-minutes/audio/wav";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import {
  alignWords,
  compareTranscripts,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { getMeetingAudio } from "../test-utils/audio-cache";

const SLUG = "gbos-2026-06-15";

let wave: WaveForm;
let ref: TranscriptWord[];
/** Starts of 2-minute stretches where the golden is dense with speech. */
let regions: number[];

beforeAll(
  async () => {
    if (process.env.SLOW !== "1") return;
    const meeting = getMeetingData(SLUG);
    wave = readWave((await getMeetingAudio(meeting)).path);
    ref = meeting.segments.flatMap((s) => s.words);
    regions = [];
    const duration = wave.samples.length / wave.sampleRate;
    for (let t = 300; t + 130 < duration && regions.length < 12; t += 600)
      if (refIn(t, t + 120).length > 250) regions.push(t);
  },
  10 * 60 * 1000,
);

/** One pass over exactly [start, end): no context either side. */
function decode(start: number, end: number): Promise<TranscriptWord[]> {
  return transcribeRange(wave, start, end, { contextSecs: 0 });
}

function refIn(start: number, end: number): TranscriptWord[] {
  return ref.filter((w) => w.start >= start && w.start < end);
}

/** For each of `refWords`, whether `hyp` has it (an alignment match). */
function found(
  refWords: readonly TranscriptWord[],
  hyp: readonly TranscriptWord[],
): boolean[] {
  const hit = refWords.map(() => false);
  for (const op of alignWords(refWords, hyp))
    if (op.op === "match") hit[op.refIdx] = true;
  return hit;
}

class Recall {
  n = 0;
  hits = 0;
  add(hit: boolean) {
    this.n++;
    if (hit) this.hits++;
  }
  get value() {
    return this.hits / this.n;
  }
  toString() {
    return `${this.value.toFixed(2)} (n=${this.n})`;
  }
}

describe("Parakeet (characterization, not requirements)", () => {
  it(
    "gives the same words every time it decodes the same samples",
    { tags: ["slow"] },
    async () => {
      // Repeating a decode, one after another or several at once, never
      // changes a word. So decoding a stretch again only helps if the
      // stretch is framed differently (see the next test).
      for (const start of regions.slice(0, 3)) {
        const first = await decode(start, start + 60);
        const again = [
          await decode(start, start + 60),
          ...(await Promise.all(
            [0, 1, 2].map(() => decode(start, start + 60)),
          )),
        ];
        for (const words of again) expect(words).toEqual(first);
      }
    },
  );

  it(
    "changes ~5% of words when the window moves by as little as 10 ms",
    { tags: ["slow"] },
    async () => {
      // Moving the window's start changes the encoder's frames (80 ms each),
      // and that alone rewrites about one word in twenty, as many as the
      // model gets wrong against the golden. Measured 2026-10 over 12
      // regions: 10 ms 4.6%, 100 ms 5.9%, 250 ms 6.9%, 1 s 7.7%, 2 s 5.2%,
      // and every region changed at every shift. So two decodes of slightly
      // different windows differ this much from framing alone.
      const wers: number[] = [];
      for (const start of regions) {
        // Compare only the middle 40 s, away from either window's edges.
        const middle = (ws: TranscriptWord[]) =>
          ws.filter((w) => w.start >= start + 10 && w.start < start + 50);
        const a = middle(await decode(start, start + 60));
        const b = middle(await decode(start + 0.01, start + 60.01));
        wers.push(compareTranscripts(a, b).wer);
      }
      const mean = wers.reduce((s, x) => s + x, 0) / wers.length;
      console.log(
        `[parakeet] 10 ms shift: WER between decodes ${mean.toFixed(4)}; per region ${wers.map((w) => w.toFixed(3)).join(" ")}`,
      );
      expect(wers.filter((w) => w > 0).length).toBeGreaterThan(wers.length / 2);
      expect(mean).toBeGreaterThan(0.01);
      expect(mean).toBeLessThan(0.15);
    },
  );

  it(
    "needs only ~0.5 s of lead-in, but loses the last word or so of a window",
    { tags: ["slow"] },
    async () => {
      // 30 s windows started at many points inside continuous speech. Recall
      // of the golden's words by how far their onset is from the window's
      // start, and from its end. Measured 2026-10: from the start, 0.81 in
      // the first 0.25 s, 0.90 to 0.5 s, then ~0.94 like the middle; from
      // the end, 0.26 in the last 0.25 s (a word cut off mid-way), ~0.85 to
      // 1 s, then ~0.94. So a window needs no seconds-long warm-up, but its
      // last second is unreliable.
      const near = 0.25;
      const startEdge = new Recall();
      const endEdge = new Recall();
      const middle = new Recall();
      for (const region of regions)
        for (let k = 0; k < 8; k++) {
          const start = region + k * 11.3;
          const end = start + 30;
          const refWords = refIn(start, end);
          const hit = found(refWords, await decode(start, end));
          refWords.forEach((w, i) => {
            if (w.start - start < near) startEdge.add(hit[i]!);
            else if (end - w.start < near) endEdge.add(hit[i]!);
            else if (w.start - start >= 3 && end - w.start >= 3)
              middle.add(hit[i]!);
          });
        }
      console.log(
        `[parakeet] recall: first ${near}s ${startEdge}; last ${near}s ${endEdge}; middle ${middle}`,
      );
      expect(middle.value).toBeGreaterThan(0.85);
      expect(startEdge.value).toBeGreaterThan(0.6);
      expect(endEdge.value).toBeLessThan(0.6);
    },
  );

  it(
    "can emit nothing for seconds of plain speech in a long pass",
    { tags: ["slow"] },
    async () => {
      // The chair reads the Open Meetings Act notice at 0:49-0:57. Decoded
      // as part of [20.9, 123.9), the model predicts blanks straight through
      // it, and the next word out is "Supervisors.310", the end of a statute
      // number glued to the word before the hole. Moving the window's start doesn't bring it back;
      // ending the window earlier, or decoding the stretch on its own, does.
      // So what drops a stretch is the rest of the window (the encoder
      // attends to all of it), not the stretch, and no window length is
      // safe from it.
      const inHole = (ws: TranscriptWord[]) =>
        ws.filter((w) => w.start >= 49 && w.start < 57.5);
      for (const start of [15, 20.9, 30, 40])
        expect(inHole(await decode(start, 123.9))).toEqual([]);
      expect(inHole(await decode(20.9, 80)).length).toBeGreaterThan(10);
      expect(inHole(await decode(45, 65)).length).toBeGreaterThan(10);
    },
  );

  it(
    "catches more words in 30 s windows than in 120 s ones",
    { tags: ["slow"] },
    async () => {
      // The same 4 minutes of six regions cut into back-to-back windows of
      // one length, cut anywhere (not at silences, so every window pays its
      // edges). Measured 2026-10, recall / runs of 5+ missed golden words /
      // decode time: 10 s 0.921/4/109 s, 20 s 0.938/2/97 s, 30 s 0.948/2/81 s,
      // 60 s 0.947/5/110 s, 120 s 0.925/9/144 s. Short windows lose words at
      // their edges, long ones drop whole stretches (see above), and 30-60 s
      // does best, fastest too.
      const recallAt = async (length: number) => {
        const recall = new Recall();
        for (const region of regions.slice(0, 6))
          for (let start = region; start < region + 240; start += length) {
            const refWords = refIn(start, start + length);
            const hit = found(refWords, await decode(start, start + length));
            hit.forEach((h) => recall.add(h));
          }
        return recall;
      };
      const short = await recallAt(30);
      const long = await recallAt(120);
      console.log(`[parakeet] recall: 30 s windows ${short}; 120 s ${long}`);
      expect(short.value).toBeGreaterThan(long.value);
    },
  );

  it("decodes at most 400 s in one pass", { tags: ["slow"] }, async () => {
    // The encoder's positional table has 5000 entries at 12.5 frames/s.
    // Past that, onnxruntime throws (a catchable error, not a crash).
    expect((await decode(1000, 1400)).length).toBeGreaterThan(0);
    await expect(decode(1000, 1420)).rejects.toThrow(/broadcast/);
  });
});
