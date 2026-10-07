import { z } from "zod";
import { defineTool, ToolError } from "../tool";
import { round } from "./activity";
import { formatClock } from "./clock";
import { checkRange, meetingRef, time } from "./inputs";
import { NOT_A_SPEAKER, type LabeledSegment } from "./meeting";
import { medianPitch } from "./pitch";
import {
  alikePairs,
  auditLabel,
  type LabelAudit,
  labelVoices,
  type Match,
  MIN_MATCH,
  MIN_REFERENCE_SECS,
  ONE_VOICE,
  references,
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
// voiceprint. voice_timeline looks closely at a few minutes; speaker_voices
// looks at each label across the whole meeting. They read the analyses in
// ./timeline.ts and ./speakers.ts and only shape the results for a model:
// times as clocks, matches as "label 0.83".

const SIMILARITY_GUIDE = `Voices are compared by CAM++ voiceprints, the model diarization uses, as "label 0.83": the label and the cosine similarity. ${SAME_PERSON} or more is very likely the same person, ${MIN_MATCH}-${SAME_PERSON} uncertain, under ${MIN_MATCH} different people. Each label's voice is sampled from its own segments (labels with under ${MIN_REFERENCE_SECS} s of speech are too thin to match against), so a label that wrongly holds two people matches both only moderately: check a label with speaker_voices before trusting a match to it.`;

const label = z
  .string()
  .describe(
    'A speaker label as the audio tools print it: "person:<slug or id>" or "speaker:<n>" (in a test clip, its PSV label).',
  );

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

export const voiceTimeline = defineTool({
  name: "voice_timeline",
  label: "Voice timeline",
  description: `A stretch of a meeting (at most ${MAX_TIMELINE_SECS / 60} minutes) as the audio hears it, in time order. The transcript's words come in passages, cut at each new segment and at each change of voice the audio hears, with each passage's median pitch and the labels its voice is most like. A passage's own label is sampled without its segment, so a wrong label can't vouch for itself: if its own label isn't near the top, the segment is likely someone else's. Between passages, a cut gives the pause and how alike the voice is either side (under ${VOICE_CHANGE}: someone else is talking; ${SAME_VOICE} or more: the same person carries on; lower than for labels, since a cut compares only a few seconds either side; null when a passage either side is under 2 s, too short to tell, where pitch is the better clue). Speech with no words shows as untranscribed. "findings" lists the cuts where the voice and the labels disagree: a change of voice where the label stays the same (a turn the transcript missed: split the segment there), or a new label where the voice carries on (a wrong boundary or label). Use it before splitting, merging or relabelling segments. ${SIMILARITY_GUIDE}`,
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
          soundsLike: top(item.soundsLike),
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
        soundsLike: top(item.soundsLike),
      };
    });

    // Labels some passage couldn't be matched to, for too little other speech.
    const tooThin = [
      ...new Set(
        timeline.items.flatMap((i) =>
          i.type === "passage" && !i.ownLabelRanked ? [i.segment.label] : [],
        ),
      ),
    ];
    return {
      from: formatClock(input.from),
      to: formatClock(input.to),
      findings,
      ...(tooThin.length > 0 && { tooThinToMatch: tooThin }),
      items,
    };
  },
});

export const speakerVoices = defineTool({
  name: "speaker_voices",
  label: "Speaker voices",
  description: `Each speaker label's voice across the whole meeting. Without a label: every label, most speech first, with whether it is one voice (its segments split into the two most different groups; groups less alike than ${ONE_VOICE} very likely mean the label holds more than one person) and how many of its segments sound like someone else, and the pairs of labels that sound alike (a "speaker:<n>" that is really a named person, or one person split over two labels). With a label, "audit" gives that label's two groups and its suspect segments, those whose voice matches another label better than its own or that fall in the smaller group of a split label. Start without a label, then look at the labels that hold more than one voice and the busiest ones, which the diarizer is likeliest to have folded someone into. ${SIMILARITY_GUIDE}`,
  input: z.object({
    meeting: meetingRef,
    label: label
      .optional()
      .describe("A speaker label to audit in detail; omit for every label."),
    minSimilarity: z
      .number()
      .min(-1)
      .max(1)
      .default(0.7)
      .describe(
        `Leave out pairs of labels less alike than this. The default is a little under ${SAME_PERSON}, so near misses show.`,
      ),
  }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const grid = voiceGrid(meeting);
    const segments = meeting.segments;
    const labels = [
      ...new Set(
        segments.map((s) => s.label).filter((l) => l !== NOT_A_SPEAKER),
      ),
    ];
    if (input.label !== undefined && !labels.includes(input.label))
      throw new ToolError(
        `No segments labelled "${input.label}". Labels: ${labels.join(", ")}`,
      );
    const voices = labelVoices(grid, segments);
    const refs = references(voices);
    const alike = alikePairs(voices, input.minSimilarity)
      .filter(
        (p) => input.label === undefined || [p.a, p.b].includes(input.label),
      )
      .map((p) => `${p.a} ~ ${p.b} ${p.similarity.toFixed(2)}`);

    if (input.label !== undefined) {
      const audit = auditLabel(grid, segments, input.label, refs);
      return { audit: auditDetail(audit), alike };
    }

    const speech = new Map<string, number>();
    for (const s of segments)
      speech.set(s.label, (speech.get(s.label) ?? 0) + s.end - s.start);
    return {
      labels: labels
        .sort((a, b) => speech.get(b)! - speech.get(a)!)
        .map((l) => {
          const audit = auditLabel(grid, segments, l, refs);
          const sampledSecs =
            voices.find((v) => v.label === l)?.sampledSecs ?? 0;
          return {
            label: l,
            segments: audit.segments,
            speechSecs: round(speech.get(l)!),
            sampledSecs: round(sampledSecs),
            ...(sampledSecs < MIN_REFERENCE_SECS && { tooThin: true }),
            verdict: audit.verdict,
            ...(audit.split && {
              groupSimilarity: round(audit.split.similarity),
            }),
            suspects: audit.measured.filter((m) => m.suspect).length,
          };
        }),
      alike,
    };
  },
});

/** One label's audit, in full. */
function auditDetail(audit: LabelAudit) {
  const twoVoices = audit.verdict === "more than one voice";
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
    suspects: audit.measured
      .filter((m) => m.suspect)
      .map((m) => ({
        segment: m.segment.id,
        from: formatClock(m.segment.start),
        to: formatClock(m.segment.end),
        ...(twoVoices && { group: m.group }),
        ownSimilarity: m.ownSimilarity && round(m.ownSimilarity),
        soundsLike: top(m.soundsLike),
        text: excerpt(m.segment),
      })),
  };
}

/** The tools that compare voices. */
export const voiceTools = [voiceTimeline, speakerVoices];
