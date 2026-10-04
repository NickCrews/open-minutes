import { beforeAll, describe, expect, it } from "vitest";
import type { TranscriptWord } from "@open-minutes/core/transcription";
import { detectSpeech } from "@open-minutes/audio/speech-runs";
import {
  loadTranscriptionModels,
  transcribeRange,
} from "@open-minutes/audio/transcribe";
import { callTool } from "../tool";
import {
  clip,
  pauses,
  type Span,
  totalSecs,
  untranscribedSpeech,
} from "./activity";
import {
  findUntranscribedSpeech,
  transcribeRangeTool,
  voiceTimeline,
} from "./tools";
import { clipContext, halfUntranscribedRollCallClip } from "./testdata/clips";

// The audio tools on real meeting audio: Silero VAD and Parakeet run on a
// checked-in clip (see testdata/clips.ts). activity.test.ts covers the span
// arithmetic on made-up spans; this checks what the models actually hear.

/** Words as lowercase text without punctuation, for loose matching. */
const plain = (words: readonly TranscriptWord[]) =>
  words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));

/** Whether `phrase` occurs as consecutive words in `words`. */
function hears(words: readonly TranscriptWord[], phrase: string): boolean {
  return ` ${plain(words).join(" ")} `.includes(` ${phrase} `);
}

// Decoding a stretch takes about a second on a laptop; leave CI headroom.
const DECODE_TIMEOUT = 60_000;

describe("on the GBOS roll call, half missing from the transcript", () => {
  const rollCall = halfUntranscribedRollCallClip();
  let runs: Span[];

  // Loading the recognizer takes several seconds (downloading it, on a cold
  // cache, minutes), longer than a test's default timeout.
  beforeAll(() => {
    loadTranscriptionModels();
    runs = detectSpeech(rollCall.wave);
  }, 10 * 60_000);

  describe("detectSpeech", () => {
    it("finds speech runs in order, inside the clip", () => {
      expect(runs.length).toBeGreaterThan(10);
      for (const [i, r] of runs.entries()) {
        expect(r.end).toBeGreaterThan(r.start);
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.end).toBeLessThanOrEqual(60);
        if (i > 0) expect(r.start).toBeGreaterThan(runs[i - 1]!.end);
      }
      // A council meeting is mostly talk.
      expect(totalSecs(runs) / 60).toBeGreaterThan(0.6);
    });

    it("hears the roll call the transcript is missing", () => {
      expect(totalSecs(clip(runs, 12, 21))).toBeGreaterThan(4);
    });

    it("shows the pause between a name and its answer", () => {
      // "Brianna Sullivan?" at 0:17.3–0:18.4, "Present." from 0:19.3.
      expect(pauses(runs, 17, 20, 0.3)).toContainEqual(
        expect.objectContaining({
          start: expect.closeTo(18.6, 0) as number,
          end: expect.closeTo(19.5, 0) as number,
        }),
      );
    });

    it("hears the quiet while the chair reads silently", () => {
      // Nobody talks from 0:53.4 to 0:55.4.
      expect(clip(runs, 53.6, 55.2)).toEqual([]);
    });
  });

  describe("untranscribedSpeech", () => {
    it("finds only the dropped half of the roll call", () => {
      const stretches = untranscribedSpeech(runs, rollCall.meeting.segments);
      expect(stretches).toHaveLength(1);
      const [s] = stretches;
      expect(s!.start).toBeGreaterThan(10);
      expect(s!.start).toBeLessThan(12.5);
      expect(s!.end).toBeGreaterThan(20);
      expect(s!.end).toBeLessThan(21.8);
      expect(s!.speechSecs).toBeGreaterThan(4);
    });
  });

  describe("transcribeRange", () => {
    it(
      "recovers the dropped roll call",
      async () => {
        // Exact spellings shift with where the window starts ("Burnett" or
        // "Brunett", "connected" or "connecting"), so match loosely.
        const words = plain(await transcribeRange(rollCall.wave, 11, 21.5));
        expect(words).toContain("brian");
        expect(words).toContain("sullivan");
        expect(words.filter((w) => w === "present")).toHaveLength(2);
      },
      DECODE_TIMEOUT,
    );

    it(
      "returns only words starting in the range",
      async () => {
        const words = await transcribeRange(rollCall.wave, 15, 18);
        expect(words.length).toBeGreaterThan(0);
        for (const w of words) {
          expect(w.start).toBeGreaterThanOrEqual(15);
          expect(w.start).toBeLessThan(18);
        }
        // "Thanks." (0:20.5) is decoded as context but left out.
        expect(plain(words)).toContain("brian");
        expect(plain(words)).not.toContain("thanks");
      },
      DECODE_TIMEOUT,
    );

    it(
      "decodes words at the range's edge with the audio around it",
      async () => {
        // The chair: "...future peoples. Thank you very much, Brian. Staff,
        // would you like to do the roll call", cut off at 0:10 mid-request.
        // Given only [5, 10) the model drops the half-heard request (it ends
        // at "Thank you very much."); with the audio around it, it hears it.
        const words = await transcribeRange(rollCall.wave, 5, 10);
        expect(words.filter((w) => w.start > 8).length).toBeGreaterThan(2);
        expect(words.at(-1)!.start).toBeLessThan(10);
      },
      DECODE_TIMEOUT,
    );

    it(
      "clamps context at the start and end of the audio",
      async () => {
        const words = await transcribeRange(rollCall.wave, 0, 3);
        expect(hears(words, "wider community")).toBe(true);
        const end = await transcribeRange(rollCall.wave, 58, 60);
        expect(hears(end, "thank you")).toBe(true);
      },
      DECODE_TIMEOUT,
    );
  });

  describe("the tools", () => {
    const ctx = clipContext(rollCall);
    const meeting = rollCall.meeting.ref;

    it(
      "voice_timeline hears each change of speaker and the missing roll call",
      async () => {
        const out = (await callTool(ctx, voiceTimeline, {
          meeting,
          from: "0:00:00",
          to: "0:01:00",
        })) as string;
        const lines = out.split("\n");
        const line = (prefix: string) =>
          lines.find((l) => l.startsWith(prefix)) ?? "";
        // The chair takes over from Brian, and the clerk from the chair.
        expect(line("── seg 1 identified:mike-edgington ──")).toContain("▲");
        expect(line("── seg 2 identified:margaret-tyler ──")).toMatch(
          /▲ voice 0\.\d\d · pitch 1\d\d→2\d\d Hz/,
        );
        // The chair's voice is low and matches his label.
        expect(line("0:00:34.46")).toMatch(
          /^0:00:34\.46 {2}1\d\d Hz {2}identified:mike-edgington 0\.[789]\d {2}\| Announcement\./,
        );
        // "Brian Burnett? Present. Brianna Sullivan? Present." has no words.
        expect(out).toMatch(/^⚠ 0:00:1\d\.\d\d-0:00:(1\d|2[01])\.\d\d /m);
        // The clerk has too little speech in a minute to match a voice to.
        expect(out).toMatch(
          /^Too little speech to match a voice against: .*identified:margaret-tyler/m,
        );
      },
      DECODE_TIMEOUT,
    );

    it(
      "voice_timeline of a segment finds the segments in the same voice",
      async () => {
        const out = (await callTool(ctx, voiceTimeline, {
          meeting,
          segment: 7,
        })) as string;
        expect(out).toMatch(
          /^ {2}closest segments: 1 identified:mike-edgington 0:00:06\.73 0\.[6-9]\d/m,
        );
        expect(out).toContain(
          "(identified:mike-edgington has too little speech besides this segment to rank)",
        );
      },
      DECODE_TIMEOUT,
    );

    it(
      "find_untranscribed_speech finds the roll call between the chair and the clerk",
      async () => {
        const out = await callTool(ctx, findUntranscribedSpeech, {
          meeting,
        });
        expect(out.found).toBe(1);
        const [s] = out.stretches;
        expect(s!.before).toMatchObject({
          label: "identified:mike-edgington",
          lastWord: expect.stringMatching(/please$/) as string,
        });
        expect(s!.after).toMatchObject({
          label: "identified:margaret-tyler",
          firstWord: expect.stringMatching(/Jennifer$/) as string,
        });
        expect(s!.heard).toMatch(/brian/i);
        expect(s!.heard).toMatch(/sullivan/i);
      },
      DECODE_TIMEOUT,
    );

    it(
      "transcribe_range shows what it hears beside the transcript",
      async () => {
        const out = await callTool(ctx, transcribeRangeTool, {
          meeting,
          from: "0:00:20",
          to: "0:00:28",
        });
        expect(out.heard).toMatch(/Jennifer/);
        expect(out.transcript.map((t) => t.label)).toEqual([
          "identified:margaret-tyler",
          "identified:jennifer-wingard",
          "identified:margaret-tyler",
          "identified:mike-edgington",
          "identified:margaret-tyler",
          "identified:mike-edgington",
        ]);
      },
      DECODE_TIMEOUT,
    );

    it("refuses a range over the limit", async () => {
      await expect(
        callTool(ctx, transcribeRangeTool, {
          meeting,
          from: 0,
          to: 200,
        }),
      ).rejects.toThrow(/at most 120 s/);
    });
  });
});
