import { z } from "zod";
import { defineTool, ToolError } from "../tool";
import { round } from "./activity";
import { formatClock } from "./clock";
import { checkRange, meetingRef, time } from "./inputs";
import type { LabeledSegment } from "./meeting";
import { medianPitch } from "./pitch";
import {
  alikePairs,
  auditLabel,
  labelVoices,
  type Match,
  matchSegment,
  MIN_MATCH,
  MIN_REFERENCE_SECS,
  ONE_VOICE,
  SAME_PERSON,
} from "./speakers";
import {
  buildTimeline,
  MAX_TIMELINE_SECS,
  SAME_VOICE,
  VOICE_CHANGE,
} from "./timeline";
import { voiceGrid } from "./voiceprints";

// Tools that compare voices: who a stretch of audio sounds like, by
// voiceprint. They read the analyses in ./speakers.ts and ./timeline.ts and
// only shape the results for a model: times as clocks, matches as
// "label 0.83".

const SIMILARITY_GUIDE = `Voices are compared by CAM++ voiceprints, the model diarization uses, as "label 0.83": the label and the cosine similarity. ${SAME_PERSON} or more is very likely the same person, ${MIN_MATCH}-${SAME_PERSON} uncertain, under ${MIN_MATCH} different people. Each label's voice is sampled from its own segments (labels with under ${MIN_REFERENCE_SECS} s of speech are too thin to match against), so a label that wrongly holds two people matches both only moderately: run audit_speaker on a label before trusting a match to it.`;

const label = z
  .string()
  .describe(
    'A speaker label as the audio tools print it: "person:<slug or id>" or "speaker:<n>" (in a test clip, its PSV label).',
  );

const segmentId = z
  .number()
  .int()
  .describe("A segment id, as get_transcript and the audio tools give it.");

/** A match as "label 0.83". */
const matchText = (m: Match) => `${m.label} ${m.similarity.toFixed(2)}`;

/** The first `n` matches as text. */
const top = (matches: readonly Match[], n = 3) =>
  matches.slice(0, n).map(matchText);

/** The first words of a segment, to recognize it by. */
function excerpt(seg: LabeledSegment, words = 12): string {
  const text = seg.words
    .slice(0, words)
    .map((w) => w.text)
    .join(" ");
  return seg.words.length > words ? `${text} …` : text;
}

function findSegment(segments: readonly LabeledSegment[], id: number) {
  const seg = segments.find((s) => s.id === id);
  if (!seg) throw new ToolError(`No segment ${id} in this meeting`);
  return seg;
}

export const voiceTimeline = defineTool({
  name: "voice_timeline",
  label: "Voice timeline",
  description: `A stretch of a meeting (at most ${MAX_TIMELINE_SECS / 60} minutes) as the audio hears it, in time order. The transcript's words come in passages, cut at each new segment and at each change of voice the audio hears, with each passage's median pitch and the label its voice is most like. Between passages, a cut gives the pause and how alike the voice is either side (under ${VOICE_CHANGE}: someone else is talking; ${SAME_VOICE} or more: the same person carries on; null when a passage either side is under 2 s, too short to tell, where pitch is the better clue). Speech with no words shows as untranscribed. "findings" lists the cuts where the voice and the labels disagree: a change of voice where the label stays the same (a turn the transcript missed: split the segment there), or a new label where the voice carries on (a wrong boundary or label). Use it before splitting, merging or relabelling segments. ${SIMILARITY_GUIDE}`,
  input: z.object({ meeting: meetingRef, from: time, to: time }),
  run: async (ctx, input) => {
    checkRange(input.from, input.to, MAX_TIMELINE_SECS);
    const meeting = await ctx.meeting(input.meeting);
    const grid = voiceGrid(meeting);
    const wave = meeting.wave();
    const timeline = buildTimeline({
      from: input.from,
      to: input.to,
      segments: meeting.segments,
      grid,
      pitch: (a, b) => medianPitch(wave, grid.speech, a, b),
    });

    const findings: string[] = [];
    let current: LabeledSegment | null = null;
    const items = timeline.items.map((item) => {
      if (item.type === "passage") {
        current = item.segment;
        return {
          type: item.type,
          at: formatClock(item.start),
          segment: item.segment.id,
          label: item.segment.label,
          text: item.text,
          pitchHz: item.pitchHz,
          soundsLike: item.soundsLike && matchText(item.soundsLike),
        };
      }
      if (item.type === "cut") {
        if (item.finding)
          findings.push(
            `${formatClock(item.at)} ${
              item.newSegment
                ? `start of segment ${item.newSegment.id}`
                : `inside segment ${current!.id}`
            }: ${item.finding}`,
          );
        return {
          type: item.type,
          at: formatClock(item.at),
          ...(item.newSegment && { newSegment: item.newSegment.id }),
          pauseSecs: round(item.pauseSecs),
          voiceSimilarity: item.voiceSimilarity && round(item.voiceSimilarity),
          ...(item.finding && { finding: item.finding }),
        };
      }
      return {
        type: item.type,
        from: formatClock(item.start),
        to: formatClock(item.end),
        speechSecs: item.speechSecs,
        pitchHz: item.pitchHz,
        soundsLike: item.soundsLike && matchText(item.soundsLike),
      };
    });

    const inView = new Set(
      timeline.items.flatMap((i) =>
        i.type === "passage" ? [i.segment.label] : [],
      ),
    );
    const tooThin = [...inView].filter((l) => !timeline.references.includes(l));
    return {
      from: formatClock(input.from),
      to: formatClock(input.to),
      findings,
      ...(tooThin.length > 0 && { tooThinToMatch: tooThin }),
      items,
    };
  },
});

export const matchVoice = defineTool({
  name: "match_voice",
  label: "Match a voice",
  description: `Whose voice one segment is: the labels its voice is most like (each label's voice sampled without this segment, so it can't vouch for its own label), and the other segments most like it. Use it to name a "speaker:<n>" segment, or to check a segment you suspect is under the wrong label. A segment needs 2 s of clear speech to be matched. ${SIMILARITY_GUIDE}`,
  input: z.object({ meeting: meetingRef, segment: segmentId }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const seg = findSegment(meeting.segments, input.segment);
    const match = matchSegment(voiceGrid(meeting), meeting.segments, seg);
    if (!match)
      throw new ToolError(
        `Segment ${seg.id} has no 2 s of clear speech to match; try voice_timeline around it`,
      );
    return {
      segment: seg.id,
      label: seg.label,
      from: formatClock(seg.start),
      to: formatClock(seg.end),
      sampledSecs: round(match.sampledSecs),
      soundsLike: top(match.soundsLike, 5),
      ...(!match.ownLabelRanked && {
        note: `${seg.label} has too little other speech to match against.`,
      }),
      closestSegments: match.closest
        .slice(0, 5)
        .map(
          (c) =>
            `${c.segment.id} ${c.label} ${formatClock(c.segment.start)} ${c.similarity.toFixed(2)}`,
        ),
    };
  },
});

export const auditSpeaker = defineTool({
  name: "audit_speaker",
  label: "Audit a speaker",
  description: `Whether everything under one speaker label is one voice. Splits the label's segments into the two most different groups of voices and says how alike the groups are (under ${ONE_VOICE}: the label very likely holds more than one person), then lists the suspect segments: those whose voice matches another label better than its own, or that fall in the smaller group of a split label. Run it on the labels with the most speech, which the diarizer is likeliest to have folded someone into, and on any label before you name it. ${SIMILARITY_GUIDE}`,
  input: z.object({ meeting: meetingRef, label }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    if (!meeting.segments.some((s) => s.label === input.label)) {
      const labels = [...new Set(meeting.segments.map((s) => s.label))];
      throw new ToolError(
        `No segments labelled "${input.label}". Labels: ${labels.join(", ")}`,
      );
    }
    const audit = auditLabel(voiceGrid(meeting), meeting.segments, input.label);
    const twoVoices = audit.verdict === "more than one voice";
    const suspects = audit.measured
      .filter((m) => m.suspect)
      .map((m) => ({
        segment: m.segment.id,
        from: formatClock(m.segment.start),
        to: formatClock(m.segment.end),
        ...(twoVoices && { group: m.group }),
        ownSimilarity: m.ownSimilarity && round(m.ownSimilarity),
        soundsLike: top(m.soundsLike),
        text: excerpt(m.segment),
      }));
    return {
      label: audit.label,
      segments: audit.segments,
      measured: audit.measured.length,
      verdict: audit.verdict,
      ...(audit.split && {
        groupSimilarity: round(audit.split.similarity),
        groups: audit.split.groups.map((g, i) => ({
          group: i,
          segments: g.segments,
          secs: round(g.secs),
          soundsLike: top(g.soundsLike),
        })),
      }),
      suspects,
    };
  },
});

export const compareSpeakers = defineTool({
  name: "compare_speakers",
  label: "Compare speakers",
  description: `Compare every speaker label in a meeting with every other by voice, and list the pairs that sound alike: a "speaker:<n>" that is really a named person, or one person split over two labels. ${SIMILARITY_GUIDE}`,
  input: z.object({
    meeting: meetingRef,
    minSimilarity: z
      .number()
      .min(-1)
      .max(1)
      .default(0.7)
      .describe("Leave out pairs less alike than this."),
  }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const voices = labelVoices(voiceGrid(meeting), meeting.segments);
    const speech = new Map<string, number>();
    for (const s of meeting.segments)
      speech.set(s.label, (speech.get(s.label) ?? 0) + s.end - s.start);
    return {
      alike: alikePairs(voices, input.minSimilarity).map(
        (p) => `${p.a} ~ ${p.b} ${p.similarity.toFixed(2)}`,
      ),
      labels: voices.map((v) => ({
        label: v.label,
        speechSecs: round(speech.get(v.label) ?? 0),
        sampledSecs: round(v.sampledSecs),
        ...(v.sampledSecs < MIN_REFERENCE_SECS && { tooThin: true }),
      })),
    };
  },
});

/** The tools that compare voices. */
export const voiceTools = [
  voiceTimeline,
  matchVoice,
  auditSpeaker,
  compareSpeakers,
];
