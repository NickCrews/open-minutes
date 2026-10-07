import {
  LAST_WORD_DURATION_SEC,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { clip, pauses, type Span, untranscribedSpeech } from "./activity";
import type { LabeledSegment } from "./meeting";
import {
  labelVoices,
  type LabelVoice,
  type Match,
  rank,
  references,
  referencesWithout,
} from "./speakers";
import { centroid, similarity } from "./vectors";
import { type VoiceGrid, type VoiceWindow, WINDOW_SEC } from "./voiceprints";

// A stretch of a meeting as the audio hears it, on one clock. The
// transcript's words are cut into passages wherever the speaker may change:
// at each new segment, and at each change of voice the audio hears. Each
// passage has its pitch and the labels its voice is most like, and each cut
// how alike the voice is either side of it. Where the voice and the labels
// disagree, the transcript likely has who-said-what wrong.

/** The longest stretch a timeline covers. */
export const MAX_TIMELINE_SECS = 5 * 60;
/** Voice either side of a cut less alike than this: someone else is talking. */
export const VOICE_CHANGE = 0.4;
/** Voice either side of a cut at least this alike: the same person carries on. */
export const SAME_VOICE = 0.7;
/** A change of voice moves to a gap between words at most this far away. */
const SNAP_SEC = 1;
/** Windows compared either side of a cut, at most: the voice near it. */
const WINDOWS_PER_SIDE = 3;
/** How far either side of a moment to look for a window with speech. */
const ACROSS_SEC = 3;
/** How far a window may run past a moment and still count as before it. */
const EDGE_SEC = 0.25;
/** Untranscribed speech shorter than this is left out (a cough, an "um"). */
const MIN_UNTRANSCRIBED_SEC = 0.5;

/** Consecutive words under one segment, with no change of voice in them. */
export interface Passage extends Span {
  type: "passage";
  segment: LabeledSegment;
  text: string;
  /** Median pitch in Hz; null with too little voiced speech. */
  pitchHz: number | null;
  /**
   * The reference labels, best match first, its own label sampled without
   * its segment, so a segment can't vouch for its own label. Empty if it's
   * under 2 s.
   */
  soundsLike: Match[];
  /** Whether its own label has enough other speech to be among soundsLike. */
  ownLabelRanked: boolean;
}

/** Where the voice and the labels disagree at a cut. */
export type Finding =
  /** The voice changes, but the label stays the same: a missed turn. */
  | "voice changes, label doesn't"
  /** The label changes, but the voice carries on: a wrong boundary or label. */
  | "label changes, voice doesn't";

/** The cut between two passages: a new segment, or a change of voice. */
export interface Cut {
  type: "cut";
  at: number;
  /** The segment that starts here; null for a change of voice inside one. */
  newSegment: LabeledSegment | null;
  /** The longest silence between the two passages' words. */
  pauseSecs: number;
  /**
   * How alike the voice just before is to just after; null if a passage
   * either side is under 2 s, too short to tell.
   */
  voiceSimilarity: number | null;
  finding: Finding | null;
}

/** Speech with no transcript words. */
export interface Untranscribed extends Span {
  type: "untranscribed";
  speechSecs: number;
  pitchHz: number | null;
  /** The reference labels, best match first; empty if it's under 2 s. */
  soundsLike: Match[];
}

export type TimelineItem = Passage | Cut | Untranscribed;

export interface Timeline {
  from: number;
  to: number;
  /** The labels voices are matched against: those with enough speech. */
  references: string[];
  /** In time order; a cut comes just before the passage it starts. */
  items: TimelineItem[];
}

export interface TimelineInput {
  from: number;
  to: number;
  /** All the meeting's segments: label voices are sampled from all of them. */
  segments: readonly LabeledSegment[];
  grid: VoiceGrid;
  /** Median pitch of the speech in [from, to), Hz, or null. */
  pitch: (from: number, to: number) => number | null;
}

type PlacedWord = TranscriptWord & { segment: LabeledSegment };

/** A passage's words, and the windows with speech lying wholly inside it. */
interface Run extends Span {
  words: PlacedWord[];
  windows: VoiceWindow[];
}

/** The timeline of [from, to). */
export function buildTimeline(input: TimelineInput): Timeline {
  const { from, to, grid } = input;
  const all = labelVoices(grid, input.segments);
  const voices = references(all);
  const without = new Map<LabeledSegment, LabelVoice[]>();
  const voicesWithout = (segment: LabeledSegment) => {
    let v = without.get(segment);
    if (!v) {
      v = referencesWithout(grid, input.segments, all, segment);
      without.set(segment, v);
    }
    return v;
  };
  const windows = grid.windows(from - ACROSS_SEC - WINDOW_SEC, to + ACROSS_SEC);
  const voicedIn = (start: number, end: number) =>
    windows.filter((w) => w.voiceprint && w.start >= start && w.end <= end);
  const words: PlacedWord[] = input.segments
    .flatMap((segment) =>
      segment.words
        .filter((w) => w.start >= from && w.start < to)
        .map((w) => ({ ...w, segment })),
    )
    .sort((a, b) => a.start - b.start);

  const groups = cutWords(words, grid.speech, changePoints(windows));
  const runs: Run[] = groups.map((words, i) => {
    const start = words[0]!.start;
    const next = groups[i + 1]?.[0]!.start ?? Infinity;
    const end = Math.min(words.at(-1)!.start + LAST_WORD_DURATION_SEC, next);
    return { words, start, end, windows: voicedIn(start, end) };
  });
  // A change of voice inside a segment stands only where the passages either
  // side confirm it; otherwise (one of them too short to tell, or the voice
  // alike after all) they are one passage again.
  for (let i = 1; i < runs.length; ) {
    const [a, b] = [runs[i - 1]!, runs[i]!];
    const similarity = voiceBetween(a, b);
    if (
      a.words.at(-1)!.segment === b.words[0]!.segment &&
      (similarity === null || similarity >= VOICE_CHANGE)
    ) {
      runs.splice(i - 1, 2, {
        words: [...a.words, ...b.words],
        start: a.start,
        end: b.end,
        windows: voicedIn(a.start, b.end),
      });
    } else {
      i++;
    }
  }

  const items: TimelineItem[] = [];
  runs.forEach((run, i) => {
    const prev = runs[i - 1];
    if (prev) items.push(cut(prev, run, grid.speech));
    const segment = run.words[0]!.segment;
    const refs = voicesWithout(segment);
    items.push({
      type: "passage",
      start: run.start,
      end: run.end,
      segment,
      text: run.words.map((w) => w.text).join(" "),
      pitchHz: input.pitch(run.start, run.end),
      soundsLike: soundsLike(run.windows, refs),
      ownLabelRanked: refs.some((v) => v.label === segment.label),
    });
  });

  const gaps = untranscribedSpeech(
    clip(grid.speech, from, to),
    input.segments,
    { minSpeechSecs: MIN_UNTRANSCRIBED_SEC, joinSecs: 1 },
  );
  for (const g of gaps)
    items.push({
      type: "untranscribed",
      ...g,
      pitchHz: input.pitch(g.start, g.end),
      soundsLike: soundsLike(voicedIn(g.start, g.end), voices),
    });

  const order = { cut: 0, untranscribed: 1, passage: 2 };
  items.sort((a, b) => timeOf(a) - timeOf(b) || order[a.type] - order[b.type]);
  return { from, to, references: voices.map((v) => v.label), items };
}

const timeOf = (item: TimelineItem) =>
  item.type === "cut" ? item.at : item.start;

/**
 * Group words into passages: a new one at each new segment and each likely
 * change of voice. A change of voice moves to the gap between words within
 * {@link SNAP_SEC} with the longest pause (people take turns at pauses),
 * unless a new segment starts that near, which is then the cut.
 */
function cutWords(
  words: readonly PlacedWord[],
  speech: readonly Span[],
  changes: readonly { at: number }[],
): PlacedWord[][] {
  // cuts[i]: whether a passage starts at word i.
  const cuts = words.map(
    (w, i) => i > 0 && w.segment !== words[i - 1]!.segment,
  );
  const pauseBefore = (i: number) =>
    longestPause(speech, words[i - 1]!.start, words[i]!.start);
  for (const change of changes) {
    const near = words
      .map((w, i) => ({ i, distance: Math.abs(w.start - change.at) }))
      .filter(({ i, distance }) => i > 0 && distance <= SNAP_SEC);
    if (near.length === 0 || near.some(({ i }) => cuts[i])) continue;
    near.sort(
      (a, b) => pauseBefore(b.i) - pauseBefore(a.i) || a.distance - b.distance,
    );
    cuts[near[0]!.i] = true;
  }
  const groups: PlacedWord[][] = [];
  words.forEach((w, i) => {
    if (i === 0 || cuts[i]) groups.push([w]);
    else groups.at(-1)!.push(w);
  });
  return groups;
}

/**
 * How alike the voice at the end of `before` is to the voice at the start of
 * `after`: the few windows nearest the cut lying wholly inside each, so
 * neither mixes in the other's speaker. Null if either is under 2 s.
 */
function voiceBetween(before: Run, after: Run): number | null {
  const end = centroid(
    before.windows.slice(-WINDOWS_PER_SIDE).map((w) => w.voiceprint!),
  );
  const start = centroid(
    after.windows.slice(0, WINDOWS_PER_SIDE).map((w) => w.voiceprint!),
  );
  return end && start ? similarity(end, start) : null;
}

/** The cut between `before` and `after`. */
function cut(before: Run, after: Run, speech: readonly Span[]): Cut {
  const [a, b] = [before.words.at(-1)!.segment, after.words[0]!.segment];
  const voiceSimilarity = voiceBetween(before, after);
  const finding: Finding | null =
    voiceSimilarity === null
      ? null
      : voiceSimilarity < VOICE_CHANGE && a.label === b.label
        ? "voice changes, label doesn't"
        : voiceSimilarity >= SAME_VOICE && a.label !== b.label
          ? "label changes, voice doesn't"
          : null;
  return {
    type: "cut",
    at: after.start,
    newSegment: a === b ? null : b,
    pauseSecs: longestPause(speech, before.words.at(-1)!.start, after.start),
    voiceSimilarity,
    finding,
  };
}

/** The longest silence in [from, to], given the speech runs. */
function longestPause(speech: readonly Span[], from: number, to: number) {
  return Math.max(
    0,
    ...pauses(speech, from, to, 0).map((p) => p.end - p.start),
  );
}

/** `voices` by how alike the voice of `windows` is to each; empty for none. */
function soundsLike(
  windows: readonly VoiceWindow[],
  voices: readonly LabelVoice[],
): Match[] {
  const voice = centroid(windows.map((w) => w.voiceprint!));
  return voice ? rank(voice, voices) : [];
}

/**
 * How alike the voice just before `at` is to the voice just after: the last
 * window with speech ending by `at` against the first starting from it (each
 * within {@link ACROSS_SEC}, so a pause between them is bridged). Null if
 * there's no speech on one side.
 */
export function voiceAcross(
  windows: readonly VoiceWindow[],
  at: number,
): number | null {
  let before: VoiceWindow | undefined;
  for (const w of windows)
    if (w.voiceprint && w.end <= at + EDGE_SEC && w.end > at - ACROSS_SEC)
      before = w;
  const after = windows.find(
    (w) =>
      w.voiceprint && w.start >= at - EDGE_SEC && w.start < at + ACROSS_SEC,
  );
  return before && after
    ? similarity(before.voiceprint!, after.voiceprint!)
    : null;
}

/**
 * Likely changes of voice: wherever the voice before a moment on the
 * windows' grid is unlike the voice after it ({@link voiceAcross} under
 * {@link VOICE_CHANGE}), one per run of such moments, at its lowest.
 */
export function changePoints(
  windows: readonly VoiceWindow[],
): { at: number; similarity: number }[] {
  const changes: { at: number; similarity: number }[] = [];
  let inRun = false;
  for (const w of windows) {
    const s = voiceAcross(windows, w.start);
    if (s === null || s >= VOICE_CHANGE) {
      inRun = false;
      continue;
    }
    const last = changes.at(-1);
    if (!inRun) changes.push({ at: w.start, similarity: s });
    else if (s < last!.similarity)
      Object.assign(last!, { at: w.start, similarity: s });
    inRun = true;
  }
  return changes;
}
