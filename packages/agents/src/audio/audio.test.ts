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
  speechActivity,
  transcribeRangeTool,
} from "./tools";
import type { LabeledSegment } from "./meeting";
import { VOICE_CHANGE } from "./timeline";
import { clipContext, halfUntranscribedRollCallClip } from "./testdata/clips";
import {
  auditSpeaker,
  compareSpeakers,
  matchVoice,
  voiceTimeline,
} from "./voice-tools";

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

    it("speech_activity reports runs, pauses and untranscribed speech", async () => {
      const out = await callTool(ctx, speechActivity, {
        meeting,
        from: "0:00:10",
        to: "0:00:30",
        minPauseSecs: 0.3,
      });
      expect(out.speechFraction).toBeGreaterThan(0.5);
      expect(out.untranscribedSpeechSecs).toBeGreaterThan(4);
      expect(out.pauses.length).toBeGreaterThan(3);
      expect(out.speechRuns?.[0]?.[0]).toMatch(/^0:00:\d\d\.\d\d$/);
    });

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

  describe("the voice tools", () => {
    const meeting = rollCall.meeting.ref;
    const CHAIR = "identified:mike-edgington";
    const BRIAN = "identified:brian-burnett";
    /** A context where the transcript has `segments` instead. */
    const relabelled = (segments: LabeledSegment[]) =>
      clipContext({
        ...rollCall,
        meeting: { ...rollCall.meeting, segments },
      });
    const segment = (id: number) =>
      rollCall.meeting.segments.find((s) => s.id === id)!;
    /** Segment `id` cut in two at the word starting at `at`, the second half under `label`. */
    function splitAt(id: number, at: number, label: string): LabeledSegment[] {
      return rollCall.meeting.segments.flatMap((s) => {
        if (s.id !== id) return [s];
        const k = s.words.findIndex((w) => w.start >= at);
        return [
          { ...s, words: s.words.slice(0, k), end: s.words[k]!.start },
          {
            ...s,
            id: 100,
            label,
            words: s.words.slice(k),
            start: s.words[k]!.start,
          },
        ];
      });
    }

    it(
      "voice_timeline lays out a minute with pitch, voices and the missing roll call",
      async () => {
        const out = await callTool(clipContext(rollCall), voiceTimeline, {
          meeting,
          from: "0:00:00",
          to: "0:01:00",
        });
        // The transcript's labels are right here, so the audio agrees.
        expect(out.findings).toEqual([]);
        const passage = (at: string) =>
          out.items.find((i) => i.type === "passage" && i.at === at) as {
            pitchHz: number | null;
            soundsLike: string | null;
          };
        // Brian's voice is higher than the chair's, and the clerk's higher still.
        expect(passage("0:00:00.01").pitchHz).toBeGreaterThan(160);
        expect(passage("0:00:06.73").pitchHz).toBeLessThan(150);
        expect(passage("0:00:21.82").pitchHz).toBeGreaterThan(200);
        // The chair's long passage is most of his label's voice.
        const [label, similarity] =
          passage("0:00:27.66").soundsLike!.split(" ");
        expect(label).toBe(CHAIR);
        expect(Number(similarity)).toBeGreaterThanOrEqual(0.75);
        // Brian and the chair are different people.
        const handover = out.items.find(
          (i) => i.type === "cut" && i.at === "0:00:06.73",
        ) as { voiceSimilarity: number | null };
        expect(handover.voiceSimilarity).toBeLessThan(VOICE_CHANGE);
        // "Brian Burnett? Present. Brianna Sullivan? Present." has no words.
        expect(out.items).toContainEqual(
          expect.objectContaining({
            type: "untranscribed",
            from: expect.stringMatching(/^0:00:1[1-3]/) as string,
          }),
        );
        // A minute is too little of the clerk to know her voice by.
        expect(out.tooThinToMatch).toContain("identified:margaret-tyler");
      },
      DECODE_TIMEOUT,
    );

    it(
      "voice_timeline finds the turn a segment hides",
      async () => {
        // As if the diarizer had run Brian's land acknowledgement and the
        // chair's thanks together under the chair.
        const merged = rollCall.meeting.segments
          .filter((s) => s.id !== 1)
          .map((s) =>
            s.id === 0
              ? {
                  ...s,
                  label: CHAIR,
                  words: [...s.words, ...segment(1).words],
                  end: segment(1).end,
                }
              : s,
          );
        const out = await callTool(relabelled(merged), voiceTimeline, {
          meeting,
          from: 0,
          to: 20,
        });
        expect(out.findings).toEqual([
          "0:00:06.73 inside segment 0: voice changes, label doesn't",
        ]);
      },
      DECODE_TIMEOUT,
    );

    it(
      "voice_timeline finds a new label where the voice carries on",
      async () => {
        const out = await callTool(
          relabelled(splitAt(7, 40.6, "segmented:spk-99")),
          voiceTimeline,
          { meeting, from: 27, to: 55 },
        );
        expect(out.findings).toEqual([
          "0:00:40.63 start of segment 100: label changes, voice doesn't",
        ]);
      },
      DECODE_TIMEOUT,
    );

    it(
      "match_voice matches the chair's thanks to the chair",
      async () => {
        const out = await callTool(clipContext(rollCall), matchVoice, {
          meeting,
          segment: 1,
        });
        expect(out.soundsLike[0]).toMatch(
          /^identified:mike-edgington 0\.[789]/,
        );
        expect(out.closestSegments[0]).toMatch(/^7 identified:mike-edgington /);
      },
      DECODE_TIMEOUT,
    );

    it(
      "audit_speaker finds Brian filed under the chair",
      async () => {
        const misfiled = rollCall.meeting.segments.map((s) =>
          s.id === 0 ? { ...s, label: CHAIR } : s,
        );
        const out = await callTool(relabelled(misfiled), auditSpeaker, {
          meeting,
          label: CHAIR,
        });
        expect(out.verdict).toBe("more than one voice");
        expect(out.suspects).toEqual([
          expect.objectContaining({
            segment: 0,
            group: 1,
            text: expect.stringMatching(/^a wider community/) as string,
          }),
        ]);
        const clean = await callTool(clipContext(rollCall), auditSpeaker, {
          meeting,
          label: CHAIR,
        });
        expect(clean.verdict).toBe("one voice");
        expect(clean.suspects).toEqual([]);
      },
      DECODE_TIMEOUT,
    );

    it(
      "compare_speakers finds one voice under two labels",
      async () => {
        const out = await callTool(
          relabelled(splitAt(7, 40.6, "segmented:spk-99")),
          compareSpeakers,
          { meeting },
        );
        expect(out.alike).toEqual([
          expect.stringMatching(
            /^identified:mike-edgington ~ segmented:spk-99 0\.[789]/,
          ),
        ]);
        expect(out.labels).toContainEqual(
          expect.objectContaining({ label: BRIAN, tooThin: true }),
        );
      },
      DECODE_TIMEOUT,
    );

    it("refuses a segment or label the meeting doesn't have", async () => {
      const ctx = clipContext(rollCall);
      await expect(
        callTool(ctx, matchVoice, { meeting, segment: 999 }),
      ).rejects.toThrow(/No segment 999/);
      await expect(
        callTool(ctx, auditSpeaker, { meeting, label: "speaker:1" }),
      ).rejects.toThrow(/No segments labelled "speaker:1"/);
      await expect(
        callTool(ctx, voiceTimeline, { meeting, from: 0, to: 400 }),
      ).rejects.toThrow(/at most 300 s/);
    });

    it(
      "match_voice refuses a segment too short to match",
      async () => {
        await expect(
          callTool(clipContext(rollCall), matchVoice, { meeting, segment: 5 }),
        ).rejects.toThrow(/no 2 s of clear speech/);
      },
      DECODE_TIMEOUT,
    );
  });
});
