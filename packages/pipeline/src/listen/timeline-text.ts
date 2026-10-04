import { formatClock } from "./clock";
import type {
  Boundary,
  Phrase,
  SoundsLike,
  Timeline,
  Untranscribed,
} from "./timeline";

// A timeline as text for a model: one line per phrase, in time order, with
// the cuts between phrases on lines of their own, so every cue sits next to
// the words it's about and carries a time a psvtool op can use.

const sim = (x: number) => x.toFixed(2);
const hz = (x: number | null) => (x === null ? "  -   " : `${x} Hz`.padEnd(6));

function voice(s: SoundsLike | null, label?: string): string {
  if (!s) return "-";
  const mark = label !== undefined && s.label !== label ? "≠ " : "";
  return `${mark}${s.label} ${sim(s.similarity)}`;
}

export const TIMELINE_KEY = [
  "Each phrase: onset, median pitch, whose voice it sounds like (≠ where that",
  "isn't the transcript's label) and its words. Between phrases: ‖ a pause,",
  "── a new segment, ▲ a likely change of speaker (two or more cues), △ a",
  "possible one (one cue), ⚠ speech with no words. Cues: voice (similarity",
  "of the voice either side, low is a change), pitch (a jump of 30% or more),",
  "sounds like (a different label either side).",
].join("\n");

function cues(b: Boundary): string {
  const parts: string[] = [];
  if (b.voiceSimilarity !== null) parts.push(`voice ${sim(b.voiceSimilarity)}`);
  if (b.pitch) parts.push(`pitch ${b.pitch[0]}→${b.pitch[1]} Hz`);
  if (b.soundsLike && b.soundsLike[0] !== b.soundsLike[1])
    parts.push(`sounds like ${b.soundsLike[0]}→${b.soundsLike[1]}`);
  if (b.pauseSecs >= 0.05) parts.push(`pause ${b.pauseSecs.toFixed(2)} s`);
  return parts.join(" · ");
}

/** `prevLabel`: the transcript's label for the phrase before the cut. */
function boundaryLine(b: Boundary, prevLabel: string): string | null {
  const mark = { change: "▲", maybe: "△", same: "", unclear: "" }[b.verdict];
  if (b.segment) {
    const head = `── seg ${b.segment.id} ${b.segment.label} ── ${formatClock(b.at)}`;
    const verdict =
      b.verdict === "same" && b.segment.label !== prevLabel
        ? "same voice? "
        : mark
          ? `${mark} `
          : "";
    return `${head}  ${verdict}${cues(b)}`.trimEnd();
  }
  if (mark) {
    const what =
      b.verdict === "change"
        ? "likely change of speaker"
        : "possible change of speaker";
    return `${mark} ${formatClock(b.at)} ${what}, inside a segment: ${cues(b)}`;
  }
  return b.pauseSecs >= 0.3 ? `‖ ${b.pauseSecs.toFixed(2)} s` : null;
}

function phraseLine(p: Phrase): string {
  return `${formatClock(p.start)}  ${hz(p.pitchHz)}  ${voice(p.soundsLike, p.label)}  | ${p.text}`;
}

function untranscribedLine(u: Untranscribed): string {
  return `⚠ ${formatClock(u.start)}-${formatClock(u.end)} ${u.speechSecs.toFixed(1)} s of speech, no words · ${hz(u.pitchHz).trim()} · ${voice(u.soundsLike)}`;
}

/** The timeline as text, for a model to read. */
export function timelineText(t: Timeline): string {
  const out: string[] = [
    `${t.meeting} ${formatClock(t.from)}-${formatClock(t.to)}`,
  ];
  if (t.focus) {
    const s = t.focus.segment;
    out.push(
      `Segment ${s.id} ${s.label}, ${formatClock(s.start)}-${formatClock(s.end)} (${(s.end - s.start).toFixed(1)} s), with a few seconds either side.`,
      t.focus.labels.length
        ? `  sounds like: ${t.focus.labels.map((l) => voice(l)).join(" · ")}`
        : "  sounds like: not enough clear speech to tell",
    );
    if (t.focus.segments.length)
      out.push(
        `  closest segments: ${t.focus.segments
          .map(
            (o) =>
              `${o.id} ${o.label} ${formatClock(o.start)} ${sim(o.similarity)}`,
          )
          .join(" · ")}`,
      );
  }
  out.push("", TIMELINE_KEY, "");

  let prevLabel: string | null = null;
  const hidden: Boundary[] = [];
  const doubtful: Boundary[] = [];
  for (const it of t.items) {
    if (it.kind === "phrase") {
      if (prevLabel === null) out.push(`── seg ${it.segment} ${it.label} ──`);
      prevLabel = it.label;
      out.push(phraseLine(it));
    } else if (it.kind === "untranscribed") out.push(untranscribedLine(it));
    else {
      if (!it.segment && it.verdict === "change") hidden.push(it);
      if (it.segment && it.verdict === "same" && it.segment.label !== prevLabel)
        doubtful.push(it);
      const line = boundaryLine(it, prevLabel ?? "");
      if (line) out.push(line);
    }
  }
  if (prevLabel === null) out.push("(no words in this stretch)");

  const gaps = t.items.filter((i) => i.kind === "untranscribed");
  const mismatched = t.items.filter(
    (i): i is Phrase =>
      i.kind === "phrase" && !!i.soundsLike && i.soundsLike.label !== i.label,
  );
  const notes = [
    hidden.length &&
      `Likely changes of speaker inside a segment: ${hidden.map((b) => formatClock(b.at)).join(", ")}.`,
    doubtful.length &&
      `New labels where the voice carries on: ${doubtful.map((b) => `${formatClock(b.at)} (seg ${b.segment!.id})`).join(", ")}.`,
    mismatched.length &&
      `Phrases that sound like another label (≠): ${mismatched.length} of ${t.items.filter((i) => i.kind === "phrase").length}.`,
    gaps.length && `Stretches of speech with no words (⚠): ${gaps.length}.`,
  ].filter(Boolean);
  if (notes.length) out.push("", ...(notes as string[]));
  return out.join("\n");
}
