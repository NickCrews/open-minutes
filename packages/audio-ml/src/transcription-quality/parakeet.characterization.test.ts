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

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { transcribeRange } from "@open-minutes/audio-ml/transcribe";
import { readWav, type WaveForm } from "@open-minutes/codecs";
import { getMeetingData } from "@open-minutes/datasets/datums";
import { type Word } from "@open-minutes/core/transcript";
import {
  alignWords,
  compareTranscripts,
} from "@open-minutes/core/transcription";
import { getMeetingAudio } from "@open-minutes/datasets/audio";

const SLUG = "gbos-2026-06-15";

let wave: WaveForm;
let ref: Word[];
/** Starts of 2-minute stretches where the golden is dense with speech. */
let regions: number[];

beforeAll(
  async () => {
    if (process.env.SLOW !== "1") return;
    const meeting = getMeetingData(SLUG);
    wave = await readWav((await getMeetingAudio(meeting)).path);
    ref = meeting.segments.flatMap((s) => s.words);
    regions = [];
    const duration = wave.samples.length / wave.sampleRate;
    for (let t = 300; t + 130 < duration && regions.length < 12; t += 600)
      if (refIn(t, t + 120).length > 250) regions.push(t);
  },
  10 * 60 * 1000,
);

/** One pass over exactly [start, end): no context either side. */
function decode(start: number, end: number): Promise<Word[]> {
  return transcribeRange(wave, start, end, { contextSecs: 0 });
}

function refIn(start: number, end: number): Word[] {
  return ref.filter((w) => w.start >= start && w.start < end);
}

/** For each of `refWords`, whether `hyp` has it (an alignment match). */
function found(refWords: readonly Word[], hyp: readonly Word[]): boolean[] {
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
        const middle = (ws: Word[]) =>
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
    "sometimes misses seconds of speech in a long pass that a short one catches",
    { tags: ["slow"] },
    async () => {
      // The same 4 minutes of six regions, cut into back-to-back 120 s
      // windows and, separately, 30 s ones. A gap is a run of 5+ consecutive
      // golden words one pass misses, of which the other pass catches at
      // least 80%. Measured 2026-11: 10 gaps in the 120 s pass, 1 in the
      // 30 s pass (over all 12 regions, 14 and 4). A 120 s gap is often a
      // whole sentence of plain speech, decoded as blanks straight through.
      // Which stretches drop flips with the window's exact start and end,
      // and with the CPU: the Open Meetings Act notice at 0:49-0:57 dropped
      // in 6 of 12 windows ending at 123.9 and starting every 4 s from 0 to
      // 44, with the next word out "Supervisors.310", the end of a statute
      // number glued to the word before the gap. So what drops a stretch is
      // the rest of the window (the encoder attends to all of it), not the
      // stretch, and a long window can lose any stretch by chance.
      const minRun = 5;
      const passHits = async (region: number, length: number) => {
        const hits: boolean[] = [];
        for (let start = region; start < region + 240; start += length)
          hits.push(
            ...found(
              refIn(start, start + length),
              await decode(start, start + length),
            ),
          );
        return hits;
      };
      /** Runs of `minRun`+ words `miss` missed and `other` mostly caught. */
      const gaps = (miss: boolean[], other: boolean[]) => {
        const out: [number, number][] = [];
        for (let i = 0; i < miss.length;) {
          let j = i;
          while (j < miss.length && !miss[j]) j++;
          const caught = other.slice(i, j).filter(Boolean).length;
          if (j - i >= minRun && caught >= 0.8 * (j - i)) out.push([i, j]);
          i = Math.max(j, i + 1);
        }
        return out;
      };
      let longGaps = 0;
      let shortGaps = 0;
      for (const region of regions.slice(0, 6)) {
        const words = refIn(region, region + 240);
        const long = await passHits(region, 120);
        const short = await passHits(region, 30);
        for (const [i, j] of gaps(long, short)) {
          longGaps++;
          console.log(
            `[parakeet] 120 s pass missed ${j - i} words at ${words[i]!.start.toFixed(1)} s: ${words
              .slice(i, j)
              .map((w) => w.text)
              .join(" ")}`,
          );
        }
        shortGaps += gaps(short, long).length;
      }
      console.log(
        `[parakeet] gaps: 120 s pass ${longGaps}; 30 s pass ${shortGaps}`,
      );
      expect(longGaps).toBeGreaterThanOrEqual(3);
      expect(longGaps).toBeGreaterThan(shortGaps);
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
