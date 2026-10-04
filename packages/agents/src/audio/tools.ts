import { z } from "zod";
import {
  cleanWords,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { transcribeRange } from "@open-minutes/audio/transcribe";
import { round, speechRuns, untranscribedSpeech } from "./activity";
import { formatClock } from "./clock";
import { defineTool } from "../tool";
import { checkRange, meetingRef, time } from "./inputs";
import type { AudioMeeting, LabeledSegment } from "./meeting";
import { buildTimeline, CONTEXT_SECS, MAX_TIMELINE_SECS } from "./timeline";
import { timelineText } from "./timeline-text";
import { SIMILARITY_GUIDE, voiceTools } from "./voice-tools";

// Tools that listen to a meeting's audio, for what the transcript's text can't
// show: two people folded under one label, or speech the recognizer skipped.
// They run on a golden fixture or a database meeting, whose audio is
// downloaded into the per-machine cache on first use.

/** The longest range transcribe_range decodes in one pass. */
const MAX_TRANSCRIBE_SECS = 120;
/** How far either side of a stretch find_untranscribed_speech reports words from (a word's onset can come a little before VAD hears it). */
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
function transcriptIn(meeting: AudioMeeting, from: number, to: number) {
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

export const voiceTimeline = defineTool({
  name: "voice_timeline",
  label: "Voice timeline",
  description: `Everything the audio says about one segment (with ${CONTEXT_SECS} s either side), or a stretch of at most ${MAX_TIMELINE_SECS / 60} minutes, as text in time order: the transcript's words cut into phrases at pauses, segment starts and changes of voice; each phrase's pitch and whose voice it sounds like; and at each cut the cues for a change of speaker (how alike the voice is either side, a jump in pitch, a different voice match, the pause), marked as a likely or possible change. Also speech with no words under it. For a segment, also whose voice the whole segment sounds like, by label (its own label leaves it out) and by segment. Use it to check who said a segment, to find where a hidden turn starts and ends inside one, and to check its edges before splitting. ${SIMILARITY_GUIDE}`,
  input: z
    .object({
      meeting: meetingRef,
      segment: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "A segment id: its index for a golden (as psvtool.py render numbers it), its row id in the database.",
        ),
      from: time.optional(),
      to: time.optional(),
    })
    .refine(
      (i) =>
        (i.segment !== undefined) !==
        (i.from !== undefined && i.to !== undefined),
      { message: "give a segment, or from and to" },
    ),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    if (input.segment !== undefined)
      return timelineText(buildTimeline(meeting, { segment: input.segment }));
    checkRange(input.from!, input.to!, MAX_TIMELINE_SECS);
    return timelineText(
      buildTimeline(meeting, { from: input.from!, to: input.to! }),
    );
  },
});

export const findUntranscribedSpeech = defineTool({
  name: "find_untranscribed_speech",
  label: "Find untranscribed speech",
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

export const transcribeRangeTool = defineTool({
  name: "transcribe_range",
  label: "Transcribe a range",
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

/** The audio tools, in the order an agent would usually reach for them. */
export const audioTools = [
  voiceTimeline,
  findUntranscribedSpeech,
  transcribeRangeTool,
  ...voiceTools,
];
