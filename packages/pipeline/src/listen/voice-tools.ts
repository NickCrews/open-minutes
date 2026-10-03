import { z } from "zod";
import { round } from "./activity";
import { formatClock } from "./clock";
import {
  type LabeledSegment,
  ListenError,
  type ListenMeeting,
} from "./meeting";
import { checkRange, defineListenTool, meetingRef, time } from "./tool";
import {
  changePoints,
  HOP_SEC,
  type LabelVoice,
  labelVoices,
  rankVoices,
  similarity,
  spanVoiceprint,
  twoMeans,
  voiceWindows,
  WINDOW_SEC,
} from "./voices";

// How to read similarities, calibrated on the golden meetings' labels.
// Repeated in the tool descriptions, which is where the model reads them.
/** Two voiceprints at least this alike are very likely the same person. */
const SAME_PERSON = 0.75;
/** A label whose two halves are less alike than this holds two voices. */
const ONE_VOICE = 0.68;
/** Labels sampled from less speech than this make unreliable references. */
const MIN_REFERENCE_SECS = 6;
/** Window-to-window similarity below this marks a likely change of voice. */
const CHANGE_THRESHOLD = 0.4;

const SIMILARITY_GUIDE = `Each "label 0.83" gives a label and its cosine similarity. Similarities are those of CAM++ voiceprints, the model diarization uses: about ${SAME_PERSON} or more is very likely the same person, 0.6-${SAME_PERSON} is uncertain, under 0.5 is different people. Voices are matched against each speaker label's voiceprint, sampled from that label's segments, so a label that wrongly holds two people matches both of them only moderately.`;

function referenceVoices(meeting: ListenMeeting): LabelVoice[] {
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

/** The transcript label covering most of [from, to], if any. */
function transcriptLabel(
  meeting: ListenMeeting,
  from: number,
  to: number,
): string | null {
  const overlap = new Map<string, number>();
  for (const s of meeting.segments) {
    const o = Math.min(s.end, to) - Math.max(s.start, from);
    if (o > 0) overlap.set(s.label, (overlap.get(s.label) ?? 0) + o);
  }
  let best: string | null = null;
  let bestSecs = 0;
  for (const [label, secs] of overlap)
    if (secs > bestSecs) [best, bestSecs] = [label, secs];
  return best;
}

export const voiceTimeline = defineListenTool({
  name: "voice_timeline",
  description: `Who it sounds like, moment to moment, in a stretch of a meeting (at most 20 minutes), from the audio. Returns runs of time with the speaker label whose voice matches best, next to the label the transcript gives there (flagging where they disagree), and the moments the voice changes, each as "time similarity" across it (lower is a sharper change), noting a segment that starts within 3 s. Use it to find where one person stops and another starts inside a long segment, or to check a stretch the diarizer may have folded into the wrong speaker. ${SIMILARITY_GUIDE}`,
  input: z.object({ meeting: meetingRef, from: time, to: time }),
  run: async (ctx, input) => {
    checkRange(input.from, input.to, 20 * 60);
    const meeting = await ctx.meeting(input.meeting);
    const voices = referenceVoices(meeting);
    const windows = voiceWindows(meeting, input.from, input.to - WINDOW_SEC);

    // Best label per window, smoothed by majority over 5 windows (2.5 s).
    const best = windows.map((w) =>
      w.embedding ? rankVoices(w.embedding, voices).slice(0, 2) : null,
    );
    const smoothed = best.map((b, i) => {
      if (!b) return null;
      const counts = new Map<string, number>();
      for (let j = i - 2; j <= i + 2; j++) {
        const label = best[j]?.[0]?.label;
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    });

    // Each window speaks for the hop-long slice at its centre.
    const sliceStart = (i: number) =>
      windows[i]!.start + (WINDOW_SEC - HOP_SEC) / 2;
    type Run = { label: string; first: number; last: number };
    const runs: Run[] = [];
    smoothed.forEach((label, i) => {
      if (!label) return;
      const run = runs.at(-1);
      // Bridge up to a second of quiet within one voice.
      if (run && run.label === label && i - run.last <= 1 / HOP_SEC + 1)
        run.last = i;
      else runs.push({ label, first: i, last: i });
    });

    // A run under a second is a blip between voices, not a turn.
    const voiceRuns = runs
      .filter((r) => r.last - r.first + 1 >= 1 / HOP_SEC)
      .map((r) => {
        const from = sliceStart(r.first);
        const to = sliceStart(r.last) + HOP_SEC;
        const sims = new Map<string, number[]>();
        for (let i = r.first; i <= r.last; i++)
          for (const v of best[i] ?? [])
            sims.set(v.label, [...(sims.get(v.label) ?? []), v.similarity]);
        const mean = (xs: number[] = []) =>
          xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
        const runnerUp = [...sims.keys()]
          .filter((l) => l !== r.label)
          .sort(
            (a, b) => (mean(sims.get(b)) ?? 0) - (mean(sims.get(a)) ?? 0),
          )[0];
        const transcript = transcriptLabel(meeting, from, to);
        return {
          from: formatClock(from),
          to: formatClock(to),
          soundsLike: r.label,
          similarity: mean(sims.get(r.label)),
          ...(runnerUp && {
            runnerUp: `${runnerUp} ${mean(sims.get(runnerUp))!.toFixed(2)}`,
          }),
          transcript,
          ...(transcript !== r.label && { disagrees: true }),
        };
      });

    const boundaries = meeting.segments.map((s) => s.start);
    return {
      voices: voiceRuns,
      changes: changePoints(windows, CHANGE_THRESHOLD).map((c) => {
        const nearest = boundaries.reduce(
          (a, b) => (Math.abs(b - c.at) < Math.abs(a - c.at) ? b : a),
          Infinity,
        );
        const atSegment =
          Math.abs(nearest - c.at) <= 3
            ? ` (a segment starts ${formatClock(nearest)})`
            : "";
        return `${formatClock(c.at)} ${c.similarity.toFixed(2)}${atSegment}`;
      }),
    };
  },
});

export const matchVoice = defineListenTool({
  name: "match_voice",
  description: `Whose voice a stretch of audio (or one segment) sounds like, ranked over the meeting's speaker labels. Needs at least 2 seconds of speech. When you pass a segment, its own label's voiceprint leaves that segment out, so the segment can't vouch for itself. ${SIMILARITY_GUIDE}`,
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
    const segment =
      input.segment === undefined
        ? null
        : meeting.segments.find((s) => s.id === input.segment);
    if (segment === undefined)
      throw new ListenError(`No segment ${input.segment} in ${meeting.ref}`);
    const span = segment ?? { start: input.from!, end: input.to! };
    if (!segment) checkRange(span.start, span.end, 20 * 60);
    const voiceprint = spanVoiceprint(meeting, span);
    if (!voiceprint)
      throw new ListenError(
        `Not enough clear speech in ${formatClock(span.start)}-${formatClock(span.end)} to match a voice (it needs about 2 s).`,
      );
    const voices = labelVoices(meeting, {
      exclude: segment ? (s) => s.id === segment.id : undefined,
    }).filter((v) => v.sampledSecs >= MIN_REFERENCE_SECS);
    return {
      from: formatClock(span.start),
      to: formatClock(span.end),
      transcript:
        segment?.label ?? transcriptLabel(meeting, span.start, span.end),
      soundsLike: top(voiceprint, voices, 5),
    };
  },
});

export const auditSpeaker = defineListenTool({
  name: "audit_speaker",
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
      throw new ListenError(
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

export const compareSpeakers = defineListenTool({
  name: "compare_speakers",
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

export const voiceTools = [
  voiceTimeline,
  matchVoice,
  auditSpeaker,
  compareSpeakers,
];
