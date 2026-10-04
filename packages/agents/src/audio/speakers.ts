import { NOT_A_SPEAKER, type LabeledSegment } from "./meeting";
import { similarity, twoMeans, type Vector } from "./vectors";
import type { Voiceprint, VoiceGrid } from "./voiceprints";

// Who a voice sounds like, by speaker label: each label's voiceprint is
// sampled from its own segments, so these are only as good as the labels. A
// label that holds two people gets a voiceprint between them, which matches
// neither well; auditLabel finds such labels.

// How to read similarities, calibrated on the golden meetings' labels.
/** Two voiceprints at least this alike are very likely one person. */
export const SAME_PERSON = 0.75;
/** A best match under this is nobody in particular. */
export const MIN_MATCH = 0.5;
/** A label whose two most different halves are less alike than this holds two voices. */
export const ONE_VOICE = 0.68;
/** A label sampled from less speech than this is too thin to match against. */
export const MIN_REFERENCE_SECS = 6;

/** Most windows sampled for a label's voiceprint. */
const MAX_LABEL_WINDOWS = 60;
/** Most windows sampled for a segment's voiceprint. */
const MAX_SEGMENT_WINDOWS = 4;

export interface LabelVoice extends Voiceprint {
  label: string;
}

export interface Match {
  label: string;
  similarity: number;
}

/** A segment's voiceprint; null if it has no voiced 2 s window. */
export function segmentVoiceprint(
  grid: VoiceGrid,
  segment: LabeledSegment,
  maxWindows = MAX_SEGMENT_WINDOWS,
): Voiceprint | null {
  return grid.voiceprint([segment], maxWindows);
}

/**
 * One voiceprint per speaker label in `segments` (in order of first
 * appearance), from windows spread across that label's segments. Labels with
 * no voiced window get none.
 */
export function labelVoices(
  grid: VoiceGrid,
  segments: readonly LabeledSegment[],
): LabelVoice[] {
  const byLabel = new Map<string, LabeledSegment[]>();
  for (const seg of segments) {
    if (seg.label === NOT_A_SPEAKER) continue;
    byLabel.set(seg.label, [...(byLabel.get(seg.label) ?? []), seg]);
  }
  return [...byLabel].flatMap(([label, segs]) => {
    const v = grid.voiceprint(segs, MAX_LABEL_WINDOWS);
    return v ? [{ label, ...v }] : [];
  });
}

/** The voices with enough speech to match against. */
export function references(voices: readonly LabelVoice[]): LabelVoice[] {
  return voices.filter((v) => v.sampledSecs >= MIN_REFERENCE_SECS);
}

/** `voices` by how alike they are to `voiceprint`, best first. */
export function rank(
  voiceprint: Vector,
  voices: readonly LabelVoice[],
): Match[] {
  return voices
    .map((v) => ({
      label: v.label,
      similarity: similarity(voiceprint, v.voiceprint),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

export interface AuditedSegment {
  segment: LabeledSegment;
  voiceprint: Vector;
  /** Its group in the label's split: 0, the larger, or 1. */
  group: 0 | 1;
  /** How alike it is to its own label's voiceprint; null if the label is too thin. */
  ownSimilarity: number | null;
  /** The reference labels, best match first. */
  soundsLike: Match[];
  /** Whether it likely isn't the label's voice. */
  suspect: boolean;
}

export interface LabelAudit {
  label: string;
  /** All the label's segments. */
  segments: number;
  verdict: "one voice" | "more than one voice" | "too few segments to tell";
  /** The two most different groups of its segments, and how alike they are. */
  split: {
    similarity: number;
    groups: [SplitGroup, SplitGroup];
  } | null;
  /** The segments long enough to have a voiceprint, in time order. */
  measured: AuditedSegment[];
}

export interface SplitGroup {
  secs: number;
  segments: number;
  soundsLike: Match[];
}

/**
 * Whether everything under `label` is one voice: split its segments into
 * the two most different groups, and check each segment against the labels'
 * voices. A segment is suspect if it matches another label better than its
 * own, or, when the label holds two voices, is in the smaller group.
 */
export function auditLabel(
  grid: VoiceGrid,
  segments: readonly LabeledSegment[],
  label: string,
): LabelAudit {
  const own = segments.filter((s) => s.label === label);
  const voices = references(labelVoices(grid, segments));
  const ownVoice = voices.find((v) => v.label === label);
  const measured = own.flatMap((segment) => {
    const v = segmentVoiceprint(grid, segment);
    return v ? [{ segment, voiceprint: v.voiceprint }] : [];
  });
  const twoGroups = twoMeans(
    measured.map((m) => ({
      voiceprint: m.voiceprint,
      weight: m.segment.end - m.segment.start,
    })),
  );
  const splitSimilarity =
    twoGroups && similarity(twoGroups.centroids[0], twoGroups.centroids[1]);
  const twoVoices = splitSimilarity !== null && splitSimilarity < ONE_VOICE;

  const audited = measured.map((m, i): AuditedSegment => {
    const group = twoGroups?.groups[i] ?? 0;
    const ownSimilarity = ownVoice
      ? similarity(m.voiceprint, ownVoice.voiceprint)
      : null;
    const soundsLike = rank(m.voiceprint, voices);
    const best = soundsLike[0];
    const matchesOther =
      !!best &&
      best.label !== label &&
      best.similarity >= MIN_MATCH &&
      (ownSimilarity === null || best.similarity > ownSimilarity);
    return {
      ...m,
      group,
      ownSimilarity,
      soundsLike,
      suspect: matchesOther || (twoVoices && group === 1),
    };
  });

  const groupOf = (g: 0 | 1): SplitGroup => {
    const members = audited.filter((a) => a.group === g);
    return {
      secs: members.reduce((n, a) => n + a.segment.end - a.segment.start, 0),
      segments: members.length,
      soundsLike: rank(twoGroups!.centroids[g], voices),
    };
  };
  return {
    label,
    segments: own.length,
    verdict:
      measured.length < 2
        ? "too few segments to tell"
        : twoVoices
          ? "more than one voice"
          : "one voice",
    split: twoGroups && {
      similarity: splitSimilarity!,
      groups: [groupOf(0), groupOf(1)],
    },
    measured: audited,
  };
}

/** Pairs of labels whose voices are at least `min` alike, most alike first. */
export function alikePairs(
  voices: readonly LabelVoice[],
  min: number,
): { a: string; b: string; similarity: number }[] {
  const pairs = [];
  for (let i = 0; i < voices.length; i++)
    for (let j = i + 1; j < voices.length; j++) {
      const s = similarity(voices[i]!.voiceprint, voices[j]!.voiceprint);
      if (s >= min)
        pairs.push({ a: voices[i]!.label, b: voices[j]!.label, similarity: s });
    }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

export interface SegmentMatch {
  segment: LabeledSegment;
  sampledSecs: number;
  /**
   * The reference labels, best first, each sampled without this segment, so
   * a segment can't vouch for its own label.
   */
  soundsLike: Match[];
  /** Whether its own label has enough other speech to be among soundsLike. */
  ownLabelRanked: boolean;
  /** The other segments, closest voice first. */
  closest: (Match & { segment: LabeledSegment })[];
}

/** Whose voice segment `segment` sounds like; null if it's too short to tell. */
export function matchSegment(
  grid: VoiceGrid,
  segments: readonly LabeledSegment[],
  segment: LabeledSegment,
): SegmentMatch | null {
  const v = segmentVoiceprint(grid, segment, MAX_LABEL_WINDOWS);
  if (!v) return null;
  const others = segments.filter((s) => s !== segment);
  const voices = references(labelVoices(grid, others));
  const closest = others.flatMap((s) => {
    const o = segmentVoiceprint(grid, s);
    return o
      ? [
          {
            segment: s,
            label: s.label,
            similarity: similarity(v.voiceprint, o.voiceprint),
          },
        ]
      : [];
  });
  return {
    segment,
    sampledSecs: v.sampledSecs,
    soundsLike: rank(v.voiceprint, voices),
    ownLabelRanked: voices.some((x) => x.label === segment.label),
    closest: closest.sort((a, b) => b.similarity - a.similarity),
  };
}
