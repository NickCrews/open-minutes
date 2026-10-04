import {
  LAST_WORD_DURATION_SEC,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import {
  clip,
  pauses,
  round,
  type Span,
  speechRuns,
  untranscribedSpeech,
} from "./activity";
import {
  ListenError,
  type LabeledSegment,
  type ListenMeeting,
} from "./meeting";
import { medianPitch } from "./signal";
import {
  CHANGE_THRESHOLD,
  MIN_REFERENCE_SECS,
  referenceVoices,
} from "./voice-tools";
import {
  centroid,
  changePoints,
  labelVoices,
  rankVoices,
  type RankedVoice,
  segmentVoices,
  similarity,
  spanVoiceprint,
  type VoiceWindow,
  voiceWindows,
  WINDOW_SEC,
} from "./voices";

// Everything the audio says about a stretch of a meeting, on one clock: the
// transcript's words cut into phrases at pauses, segment boundaries and
// changes of voice, each phrase with its pitch and whose voice it sounds
// like, and at each cut the cues for and against a change of speaker. This
// is the data; ./timeline-text.ts writes it out for a model.

/** The longest stretch a timeline covers. */
export const MAX_TIMELINE_SECS = 5 * 60;
/** Seconds shown either side of a segment asked for by id. */
export const CONTEXT_SECS = 5;
/** A silence between words at least this long starts a new phrase. */
const MIN_PAUSE_SEC = 0.3;
/** A phrase running longer than this is cut at the next word. */
const MAX_PHRASE_SEC = 8;
/** Two phrases' pitches this far apart (as a ratio) are a cue the speaker changed. */
export const PITCH_JUMP_RATIO = 1.3;
/** Voiceprints at least this alike across a cut mean the voice carries on. */
export const SAME_VOICE = 0.6;
/** Seconds of audio either side of a cut compared for a change of voice. */
const ACROSS_SEC = 3;
/** Untranscribed speech shorter than this is left out (a cough, an "um"). */
const MIN_UNTRANSCRIBED_SECS = 0.5;

export interface SoundsLike {
  label: string;
  similarity: number;
}

/** Words one speaker said without a pause, under one segment. */
export interface Phrase {
  kind: "phrase";
  start: number;
  end: number;
  segment: number;
  /** The transcript's label for it. */
  label: string;
  text: string;
  /** Median pitch, Hz; null with too little voiced speech to tell. */
  pitchHz: number | null;
  /** The label whose voice most of its voiceprint windows match. */
  soundsLike: SoundsLike | null;
}

/** Speech the transcript has no words for. */
export interface Untranscribed {
  kind: "untranscribed";
  start: number;
  end: number;
  speechSecs: number;
  pitchHz: number | null;
  soundsLike: SoundsLike | null;
}

/** How a cut between two phrases reads: does the speaker change there? */
export type Verdict = "change" | "maybe" | "same" | "unclear";

/** The cut between two phrases, with the cues for a change of speaker. */
export interface Boundary {
  kind: "boundary";
  at: number;
  /** The segment starting here; null for a cut inside a segment. */
  segment: { id: number; label: string } | null;
  /** The longest silence between the two phrases' words. */
  pauseSecs: number;
  /** Similarity of the voice just before the cut with just after it. */
  voiceSimilarity: number | null;
  /** Pitch before and after, Hz, when both are known. */
  pitch: [number, number] | null;
  /** Whose voice it sounds like before and after, when both are known. */
  soundsLike: [string, string] | null;
  /** Which cues point to a change of speaker. */
  cues: ("voice" | "pitch" | "sounds like")[];
  verdict: Verdict;
}

export type TimelineItem = Phrase | Untranscribed | Boundary;

export interface SegmentSummary {
  id: number;
  label: string;
  start: number;
  end: number;
}

/** For a timeline of one segment: who the whole segment sounds like. */
export interface Focus {
  segment: SegmentSummary;
  /** Labels ranked by voice; the segment's own label leaves it out. */
  labels: SoundsLike[];
  /** The other segments whose voice is most like it. */
  segments: (SegmentSummary & { similarity: number })[];
}

export interface Timeline {
  meeting: string;
  from: number;
  to: number;
  focus: Focus | null;
  /** The segments with words in [from, to), in time order. */
  segments: SegmentSummary[];
  /** Phrases, untranscribed speech and the cuts between phrases, in time order. */
  items: TimelineItem[];
}

/** What {@link assembleTimeline} needs: the measurements, without the audio. */
export interface TimelineInputs {
  from: number;
  to: number;
  segments: readonly LabeledSegment[];
  /** Speech runs (VAD) overlapping [from, to]. */
  speech: readonly Span[];
  /** Voiceprint windows covering [from, to], each with its best-matching label. */
  windows: readonly (VoiceWindow & { best: RankedVoice | null })[];
  /** Likely changes of voice, from the windows' continuity. */
  changes: readonly { at: number; similarity: number }[];
  /** Median pitch of the speech in [from, to), Hz, or null. */
  pitch: (from: number, to: number) => number | null;
}

/**
 * The timeline of [from, to] in `meeting`, or of segment `segmentId` with
 * {@link CONTEXT_SECS} either side.
 */
export function buildTimeline(
  meeting: ListenMeeting,
  range: { from: number; to: number } | { segment: number },
): Timeline {
  let from: number;
  let to: number;
  let focusSeg: LabeledSegment | null = null;
  if ("segment" in range) {
    focusSeg = meeting.segments.find((s) => s.id === range.segment) ?? null;
    if (!focusSeg)
      throw new ListenError(`No segment ${range.segment} in ${meeting.ref}`);
    from = Math.max(0, focusSeg.start - CONTEXT_SECS);
    to = focusSeg.end + CONTEXT_SECS;
    if (to - from > MAX_TIMELINE_SECS)
      throw new ListenError(
        `Segment ${focusSeg.id} is ${Math.round(focusSeg.end - focusSeg.start)} s long; give from and to to look at up to ${MAX_TIMELINE_SECS / 60} minutes of it at a time.`,
      );
  } else {
    ({ from, to } = range);
  }

  const speech = clip(speechRuns(meeting), from - ACROSS_SEC, to + ACROSS_SEC);
  const voices = referenceVoices(meeting);
  const windows = voiceWindows(
    meeting,
    Math.max(0, from - ACROSS_SEC),
    to + ACROSS_SEC - WINDOW_SEC,
  ).map((w) => ({
    ...w,
    best: w.embedding ? (rankVoices(w.embedding, voices)[0] ?? null) : null,
  }));
  const wave = meeting.wave();
  const timeline = assembleTimeline({
    from,
    to,
    segments: meeting.segments,
    speech,
    windows,
    changes: changePoints(windows, CHANGE_THRESHOLD),
    pitch: (a, b) =>
      medianPitch(wave.samples, wave.sampleRate, speech, a, b).hz,
  });
  return {
    meeting: meeting.ref,
    ...timeline,
    focus: focusSeg && focusOf(meeting, focusSeg),
  };
}

const summary = (s: LabeledSegment): SegmentSummary => ({
  id: s.id,
  label: s.label,
  start: s.start,
  end: s.end,
});

function focusOf(meeting: ListenMeeting, seg: LabeledSegment): Focus {
  const voiceprint = spanVoiceprint(meeting, seg);
  if (!voiceprint) return { segment: summary(seg), labels: [], segments: [] };
  const labels = labelVoices(meeting, {
    exclude: (s) => s.id === seg.id,
  }).filter((v) => v.sampledSecs >= MIN_REFERENCE_SECS);
  const byId = new Map(meeting.segments.map((s) => [s.id, s]));
  const others = [...segmentVoices(meeting)]
    .filter(([id]) => id !== seg.id)
    .map(([id, v]) => ({
      ...summary(byId.get(id)!),
      similarity: round(similarity(voiceprint, v)),
    }))
    .sort((a, b) => b.similarity - a.similarity);
  return {
    segment: summary(seg),
    labels: rankVoices(voiceprint, labels)
      .slice(0, 5)
      .map((r) => ({ label: r.label, similarity: round(r.similarity) })),
    segments: others.slice(0, 5),
  };
}

type PlacedWord = TranscriptWord & { seg: LabeledSegment };

/** Lay the measurements out as a timeline. Pure, so it can be tested. */
export function assembleTimeline(
  inputs: TimelineInputs,
): Omit<Timeline, "meeting" | "focus"> {
  const { from, to, speech } = inputs;
  const words: PlacedWord[] = inputs.segments
    .flatMap((seg) =>
      seg.words
        .filter((w) => w.start >= from && w.start < to)
        .map((w) => ({ ...w, seg })),
    )
    .sort((a, b) => a.start - b.start);

  // Cut before the first word at or after each change of voice (give or
  // take a quarter second: the windows are half a second apart).
  const cutBefore = new Set<number>();
  for (const c of inputs.changes) {
    const i = words.findIndex((w) => w.start >= c.at - 0.25);
    if (i > 0) cutBefore.add(i);
  }

  const groups: PlacedWord[][] = [];
  words.forEach((w, i) => {
    const group = groups.at(-1);
    const prev = words[i - 1];
    const split =
      !group ||
      !prev ||
      w.seg !== prev.seg ||
      cutBefore.has(i) ||
      w.start - group[0]!.start > MAX_PHRASE_SEC ||
      silenceBetween(speech, prev.start, w.start) >= MIN_PAUSE_SEC;
    if (split) groups.push([w]);
    else group.push(w);
  });

  const phrases: Phrase[] = groups.map((g, i) => {
    const start = g[0]!.start;
    const next = groups[i + 1]?.[0]!.start ?? Infinity;
    const end = Math.min(g.at(-1)!.start + LAST_WORD_DURATION_SEC, next);
    return {
      kind: "phrase",
      start,
      end: round(end),
      segment: g[0]!.seg.id,
      label: g[0]!.seg.label,
      text: g.map((w) => w.text).join(" "),
      pitchHz: roundHz(inputs.pitch(start, end)),
      soundsLike: soundsLikeIn(inputs.windows, start, end),
    };
  });

  const items: TimelineItem[] = [...phrases, ...untranscribed(inputs)];
  phrases.forEach((p, i) => {
    const prev = phrases[i - 1];
    if (prev)
      items.push(boundaryBetween(inputs, prev, groups[i - 1]!.at(-1)!, p));
  });
  // In time order; a cut comes just before the phrase it starts.
  const rank = { boundary: 0, untranscribed: 1, phrase: 2 };
  items.sort(
    (x, y) => itemTime(x) - itemTime(y) || rank[x.kind] - rank[y.kind],
  );

  const segments = new Map<number, SegmentSummary>();
  for (const w of words)
    if (!segments.has(w.seg.id)) segments.set(w.seg.id, summary(w.seg));
  return { from, to, segments: [...segments.values()], items };
}

const itemTime = (it: TimelineItem) =>
  it.kind === "boundary" ? it.at : it.start;

const roundHz = (hz: number | null) => (hz === null ? null : Math.round(hz));

/** The longest silence in [from, to], given the speech runs. */
function silenceBetween(speech: readonly Span[], from: number, to: number) {
  return Math.max(
    0,
    ...pauses(speech, from, to, 0).map((p) => p.end - p.start),
  );
}

/**
 * The label most of the windows centred in [from, to) match best, with its
 * mean similarity over them. Each window speaks for the hop-long slice at its
 * centre.
 */
function soundsLikeIn(
  windows: TimelineInputs["windows"],
  from: number,
  to: number,
): SoundsLike | null {
  const sims = new Map<string, number[]>();
  for (const w of windows) {
    const centre = w.start + WINDOW_SEC / 2;
    if (!w.best || centre < from || centre >= to) continue;
    sims.set(w.best.label, [
      ...(sims.get(w.best.label) ?? []),
      w.best.similarity,
    ]);
  }
  const [best] = [...sims].sort((a, b) => b[1].length - a[1].length);
  if (!best) return null;
  const [label, xs] = best;
  return {
    label,
    similarity: round(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

/** Windows ending this far past a cut (or starting this far before) still count for its side. */
const EDGE_SEC = 0.25;
/** Windows taken either side of a cut. */
const WINDOWS_PER_SIDE = 3;

/**
 * The voice just before `at` (side "before", phrase `p` ending there) or just
 * after it (side "after", `p` starting there): the centroid of the nearest
 * few windows with speech that sit on that side and are centred near `p`. A
 * window is 2 s, so for a phrase much shorter than that, fall back to the
 * nearest window within ACROSS_SEC.
 */
function voiceBeside(
  windows: TimelineInputs["windows"],
  p: Phrase,
  at: number,
  side: "before" | "after",
) {
  const voiced = windows.filter((w) => w.embedding);
  const onSide =
    side === "before"
      ? voiced.filter((w) => w.end <= at + EDGE_SEC)
      : voiced.filter((w) => w.start >= at - EDGE_SEC);
  const near = onSide.filter((w) => {
    const centre = w.start + WINDOW_SEC / 2;
    return centre >= p.start - 0.5 && centre <= p.end + 0.5;
  });
  const fallback = onSide.filter((w) =>
    side === "before" ? w.end > at - ACROSS_SEC : w.start < at + ACROSS_SEC,
  );
  // The `n` windows closest to the cut.
  const closest = (ws: typeof voiced, n: number) =>
    side === "before" ? ws.slice(-n) : ws.slice(0, n);
  const chosen = near.length
    ? closest(near, WINDOWS_PER_SIDE)
    : closest(fallback, 1);
  return centroid(chosen.map((w) => w.embedding!));
}

function boundaryBetween(
  inputs: TimelineInputs,
  a: Phrase,
  aLastWord: TranscriptWord,
  b: Phrase,
): Boundary {
  const at = b.start;
  const before = voiceBeside(inputs.windows, a, at, "before");
  const after = voiceBeside(inputs.windows, b, at, "after");
  const voiceSimilarity =
    before && after ? round(similarity(before, after)) : null;
  const pitch: [number, number] | null =
    a.pitchHz !== null && b.pitchHz !== null ? [a.pitchHz, b.pitchHz] : null;
  const soundsLike: [string, string] | null =
    a.soundsLike && b.soundsLike
      ? [a.soundsLike.label, b.soundsLike.label]
      : null;

  const cues: Boundary["cues"] = [];
  if (voiceSimilarity !== null && voiceSimilarity < CHANGE_THRESHOLD)
    cues.push("voice");
  if (pitch && Math.max(...pitch) / Math.min(...pitch) >= PITCH_JUMP_RATIO)
    cues.push("pitch");
  if (soundsLike && soundsLike[0] !== soundsLike[1]) cues.push("sounds like");
  const verdict: Verdict =
    cues.length >= 2
      ? "change"
      : cues.length === 1
        ? "maybe"
        : voiceSimilarity !== null && voiceSimilarity >= SAME_VOICE
          ? "same"
          : "unclear";

  return {
    kind: "boundary",
    at,
    segment: a.segment === b.segment ? null : { id: b.segment, label: b.label },
    pauseSecs: round(silenceBetween(inputs.speech, aLastWord.start, b.start)),
    voiceSimilarity,
    pitch,
    soundsLike,
    cues,
    verdict,
  };
}

/** Speech in [from, to) the transcript's words don't account for. */
function untranscribed(inputs: TimelineInputs): Untranscribed[] {
  return untranscribedSpeech(
    clip(inputs.speech, inputs.from, inputs.to),
    inputs.segments,
    { minSpeechSecs: MIN_UNTRANSCRIBED_SECS, joinSecs: 1 },
  ).map((u) => ({
    kind: "untranscribed",
    ...u,
    pitchHz: roundHz(inputs.pitch(u.start, u.end)),
    soundsLike: soundsLikeIn(inputs.windows, u.start, u.end),
  }));
}
