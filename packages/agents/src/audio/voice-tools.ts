import { z } from "zod";
import { round } from "./activity";
import { formatClock } from "./clock";
import type { AudioMeeting, LabeledSegment } from "./meeting";
import { defineTool, ToolError } from "../tool";
import { meetingRef } from "./inputs";
import {
  type LabelVoice,
  labelVoices,
  rankVoices,
  similarity,
  spanVoiceprint,
  twoMeans,
} from "./voices";

// How to read similarities, calibrated on the golden meetings' labels.
// Repeated in the tool descriptions, which is where the model reads them.
/** Two voiceprints at least this alike are very likely the same person. */
export const SAME_PERSON = 0.75;
/** A label whose two halves are less alike than this holds two voices. */
export const ONE_VOICE = 0.68;
/** Labels sampled from less speech than this make unreliable references. */
export const MIN_REFERENCE_SECS = 6;
/** Window-to-window similarity below this marks a likely change of voice. */
export const CHANGE_THRESHOLD = 0.4;

export const SIMILARITY_GUIDE = `Each "label 0.83" gives a label and its cosine similarity. Similarities are those of CAM++ voiceprints, the model diarization uses: about ${SAME_PERSON} or more is very likely the same person, 0.6-${SAME_PERSON} is uncertain, under 0.5 is different people. Voices are matched against each speaker label's voiceprint, sampled from that label's segments, so a label that wrongly holds two people matches both of them only moderately.`;

export function referenceVoices(meeting: AudioMeeting): LabelVoice[] {
  return labelVoices(meeting).filter(
    (v) => v.sampledSecs >= MIN_REFERENCE_SECS,
  );
}

function top(
  voiceprint: Float32Array,
  voices: readonly LabelVoice[],
  n: number,
) {
  return rankVoices(voiceprint, voices)
    .slice(0, n)
    .map((r) => `${r.label} ${r.similarity.toFixed(2)}`);
}

function excerpt(seg: LabeledSegment, words = 14): string {
  const text = seg.words
    .slice(0, words)
    .map((w) => w.text)
    .join(" ");
  return seg.words.length > words ? `${text} …` : text;
}

export const auditSpeaker = defineTool({
  name: "audit_speaker",
  label: "Audit speaker",
  description: `Check whether everything under one speaker label is really one voice. Splits the label's segments into the two most different groups of voices and says how alike the groups are (under ${ONE_VOICE} means the label very likely covers two or more people), then lists the segments that sound like someone else: a segment whose voice matches another label better than its own, or that falls in the smaller group of a split label. Run it on the labels with the most segments, which the diarizer is likeliest to have merged into, and on any label you're about to name. ${SIMILARITY_GUIDE}`,
  input: z.object({
    meeting: meetingRef,
    label: z
      .string()
      .describe(
        'A speaker label as the transcript writes it: "identified:<slug>" or "segmented:spk-<n>" in a golden, "person:<slug or id>" or "speaker:<n>" in the database.',
      ),
    all: z
      .boolean()
      .default(false)
      .describe("List every segment, not just the suspect ones."),
  }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const segments = meeting.segments.filter((s) => s.label === input.label);
    if (segments.length === 0) {
      const labels = [...new Set(meeting.segments.map((s) => s.label))];
      throw new ToolError(
        `No segments labelled "${input.label}". Labels: ${labels.join(", ")}`,
      );
    }
    const voices = referenceVoices(meeting);
    const own = voices.find((v) => v.label === input.label);
    const measured = segments
      .map((seg) => ({ seg, voiceprint: spanVoiceprint(meeting, seg) }))
      .filter(
        (m): m is { seg: LabeledSegment; voiceprint: Float32Array } =>
          m.voiceprint !== null,
      );
    const split = twoMeans(
      measured.map((m) => ({
        voiceprint: m.voiceprint,
        weight: m.seg.end - m.seg.start,
      })),
    );
    const groupsAlike = split
      ? similarity(split.centroids[0], split.centroids[1])
      : null;
    const twoVoices = groupsAlike !== null && groupsAlike < ONE_VOICE;

    const rows = measured.map((m, i) => {
      const ranked = top(m.voiceprint, voices, 3);
      const ownSimilarity = own
        ? round(similarity(m.voiceprint, own.voiceprint))
        : null;
      const better = !ranked[0]!.startsWith(`${input.label} `);
      const group = split?.groups[i] ?? 0;
      return {
        segment: m.seg.id,
        from: formatClock(m.seg.start),
        to: formatClock(m.seg.end),
        secs: round(m.seg.end - m.seg.start),
        ...(twoVoices && { group }),
        ownSimilarity,
        soundsLike: ranked,
        text: excerpt(m.seg),
        suspect: better || (twoVoices && group === 1),
      };
    });
    const secsOf = (g: number) =>
      round(
        measured.reduce(
          (n, m, i) =>
            n + (split?.groups[i] === g ? m.seg.end - m.seg.start : 0),
          0,
        ),
      );
    return {
      label: input.label,
      segments: segments.length,
      measured: measured.length,
      verdict: !split
        ? "too few segments with clear speech to tell"
        : twoVoices
          ? "likely more than one voice"
          : "one voice",
      ...(split && {
        groups: [0, 1].map((g) => ({
          group: g,
          secs: secsOf(g),
          segments: split.groups.filter((x) => x === g).length,
          soundsLike: top(split.centroids[g as 0 | 1], voices, 3),
        })),
        groupSimilarity: round(groupsAlike!),
      }),
      [input.all ? "segmentDetails" : "suspects"]: rows.filter(
        (r) => input.all || r.suspect,
      ),
    };
  },
});

export const compareSpeakers = defineTool({
  name: "compare_speakers",
  label: "Compare speakers",
  description: `Compare every speaker label in a meeting with every other by voice, and list the pairs that sound alike: an anonymous speaker number that is really a named person, or one person split across two labels. ${SIMILARITY_GUIDE}`,
  input: z.object({
    meeting: meetingRef,
    minSimilarity: z.number().min(-1).max(1).default(0.7),
  }),
  run: async (ctx, input) => {
    const meeting = await ctx.meeting(input.meeting);
    const voices = labelVoices(meeting);
    const pairs: { a: string; b: string; similarity: number }[] = [];
    for (let i = 0; i < voices.length; i++)
      for (let j = i + 1; j < voices.length; j++) {
        const sim = similarity(voices[i]!.voiceprint, voices[j]!.voiceprint);
        if (sim >= input.minSimilarity)
          pairs.push({
            a: voices[i]!.label,
            b: voices[j]!.label,
            similarity: round(sim),
          });
      }
    const speech = new Map<string, number>();
    for (const s of meeting.segments)
      speech.set(s.label, (speech.get(s.label) ?? 0) + s.end - s.start);
    return {
      alike: pairs
        .sort((x, y) => y.similarity - x.similarity)
        .map((p) => `${p.a} ~ ${p.b} ${p.similarity.toFixed(2)}`),
      labels: voices.map((v) => ({
        label: v.label,
        speechSecs: round(speech.get(v.label) ?? 0),
        sampledSecs: v.sampledSecs,
        ...(v.sampledSecs < MIN_REFERENCE_SECS && { unreliable: true }),
      })),
    };
  },
});

export const voiceTools = [auditSpeaker, compareSpeakers];
