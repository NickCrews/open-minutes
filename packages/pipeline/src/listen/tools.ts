import { z } from "zod";
import {
  cleanWords,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { transcribeRange } from "../transcribe";
import {
  clip,
  pauses,
  round,
  speechRuns,
  totalSecs,
  untranscribedSpeech,
} from "./activity";
import { formatClock } from "./clock";
import type { LabeledSegment, ListenMeeting } from "./meeting";
import {
  checkRange,
  defineListenTool,
  type ListenTool,
  meetingRef,
  time,
} from "./tool";

/** The longest range transcribe_range decodes in one pass. */
const MAX_TRANSCRIBE_SECS = 120;
/** How much audio either side of a stretch find_untranscribed_speech decodes. */
const TRANSCRIBE_PAD_SECS = 0.5;

/** Words as one line, each sentence prefixed with its first word's onset. */
function wordsText(words: readonly TranscriptWord[]): string {
  let out = "";
  let sentenceStart = true;
  for (const w of words) {
    if (sentenceStart) out += `${out ? " " : ""}[${formatClock(w.start)}] `;
    else out += " ";
    out += w.text;
    sentenceStart = /[.?!]$/.test(w.text);
  }
  return out;
}

/** The transcript's segments overlapping [from, to], each with its words in range. */
function transcriptIn(meeting: ListenMeeting, from: number, to: number) {
  return meeting.segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({
      segment: s.id,
      label: s.label,
      text: wordsText(s.words.filter((w) => w.start >= from && w.start < to)),
    }))
    .filter((s) => s.text);
}

/** The segment holding the last word before `t`, and the one holding the first word at or after it. */
function neighbours(segments: readonly LabeledSegment[], t: number) {
  let before: { seg: LabeledSegment; word: TranscriptWord } | null = null;
  let after: { seg: LabeledSegment; word: TranscriptWord } | null = null;
  for (const seg of segments) {
    for (const word of seg.words) {
      if (word.start < t) before = { seg, word };
      else if (!after) after = { seg, word };
    }
  }
  return { before, after };
}

export const speechActivity = defineListenTool({
  name: "speech_activity",
  description:
    "Where someone is talking in a stretch of a meeting, from voice activity detection on the audio (not the transcript): the speech runs, the pauses between them, and how much speech the transcript's words don't account for. Use it to find the silence where one turn ends and the next begins, or to check whether a quiet stretch really is quiet.",
  input: z.object({
    meeting: meetingRef,
    from: time,
    to: time,
    minPauseSecs: z
      .number()
      .positive()
      .default(0.5)
      .describe("Shortest silence to report as a pause."),
  }),
  run: async (ctx, input) => {
    checkRange(input.from, input.to, 30 * 60);
    const meeting = await ctx.meeting(input.meeting);
    const runs = clip(speechRuns(meeting), input.from, input.to);
    const gaps = untranscribedSpeech(runs, meeting.segments, {
      minSpeechSecs: 0.5,
    });
    const span = input.to - input.from;
    return {
      from: formatClock(input.from),
      to: formatClock(input.to),
      speechSecs: round(totalSecs(runs)),
      speechFraction: round(totalSecs(runs) / span),
      untranscribedSpeechSecs: round(
        gaps.reduce((n, g) => n + g.speechSecs, 0),
      ),
      pauses: pauses(runs, input.from, input.to, input.minPauseSecs).map(
        (p) => ({
          from: formatClock(p.start),
          to: formatClock(p.end),
          secs: round(p.end - p.start),
        }),
      ),
      ...(runs.length <= 200 && {
        speechRuns: runs.map((r) => [formatClock(r.start), formatClock(r.end)]),
      }),
    };
  },
});

export const findUntranscribedSpeech = defineListenTool({
  name: "find_untranscribed_speech",
  description:
    "Find stretches where the audio has speech but the transcript has no words: a turn the recognizer skipped, a roll call answered under the chair's words, or words cut from a golden by mistake. For each stretch, gives the words just before and after it, and (unless transcribe is false) what speech recognition hears when it decodes just that stretch, so you can put the missing words back under the right speaker.",
  input: z.object({
    meeting: meetingRef,
    from: time.optional(),
    to: time.optional(),
    minSpeechSecs: z
      .number()
      .positive()
      .default(2)
      .describe(
        "Leave out stretches with less untranscribed speech than this.",
      ),
    transcribe: z
      .boolean()
      .default(true)
      .describe("Decode each stretch with speech recognition (slower)."),
    limit: z.number().int().positive().default(50),
  }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const from = input.from ?? 0;
    const to = input.to ?? Infinity;
    const runs = speechRuns(meeting).filter(
      (r) => r.end > from && r.start < to,
    );
    const stretches = untranscribedSpeech(runs, meeting.segments, {
      minSpeechSecs: input.minSpeechSecs,
    });
    const shown = stretches.slice(0, input.limit);
    const results = [];
    for (const s of shown) {
      const { before, after } = neighbours(meeting.segments, s.start);
      const heard = input.transcribe
        ? cleanWords(
            await transcribeRange(
              meeting.wave(),
              Math.max(0, s.start - TRANSCRIBE_PAD_SECS),
              s.end + TRANSCRIBE_PAD_SECS,
            ),
          ).words
        : null;
      results.push({
        from: formatClock(s.start),
        to: formatClock(s.end),
        speechSecs: s.speechSecs,
        before: before && {
          segment: before.seg.id,
          label: before.seg.label,
          lastWord: `[${formatClock(before.word.start)}] ${before.word.text}`,
        },
        after: after && {
          segment: after.seg.id,
          label: after.seg.label,
          firstWord: `[${formatClock(after.word.start)}] ${after.word.text}`,
        },
        ...(heard && { heard: wordsText(heard) }),
      });
    }
    return {
      found: stretches.length,
      totalSpeechSecs: round(stretches.reduce((n, s) => n + s.speechSecs, 0)),
      ...(stretches.length > shown.length && {
        note: `Showing the first ${shown.length}; narrow from/to or raise limit for the rest.`,
      }),
      stretches: results,
    };
  },
});

export const transcribeRangeTool = defineListenTool({
  name: "transcribe_range",
  description: `Run speech recognition on just one stretch of a meeting's audio (at most ${MAX_TRANSCRIBE_SECS} s), and show it next to what the transcript has there. Decoding a short stretch on its own often recovers words the full-meeting pass dropped, and the onsets tell you where a missing word goes. Fillers and stutters are removed, as in the pipeline, unless raw is true.`,
  input: z.object({
    meeting: meetingRef,
    from: time,
    to: time,
    raw: z.boolean().default(false),
  }),
  run: async (ctx, input) => {
    checkRange(input.from, input.to, MAX_TRANSCRIBE_SECS);
    const meeting = await ctx.meeting(input.meeting);
    const words = await transcribeRange(meeting.wave(), input.from, input.to);
    const heard = input.raw ? words : cleanWords(words).words;
    return {
      heard: wordsText(heard),
      words: heard.map((w) => `${formatClock(w.start)} ${w.text}`),
      transcript: transcriptIn(meeting, input.from, input.to),
    };
  },
});

export const listenTools: ListenTool[] = [
  speechActivity,
  findUntranscribedSpeech,
  transcribeRangeTool,
] as ListenTool[];
