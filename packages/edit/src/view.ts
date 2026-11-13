// Reading a meeting from a database: its transcript a segment at a time, its
// words, who speaks how much, and what the meeting rules find in it.

import { formatClock } from "@open-minutes/core/clock";
import {
  BODY_RULE_SPECS,
  checkMeeting,
  type MeetingIssue,
  RULE_SPECS,
  type RuleMeeting,
} from "@open-minutes/core/rules";
import type { Segment } from "@open-minutes/core/transcript";
import { bodyRuleCodes } from "@open-minutes/datasets/datums";
import type { DbMeeting, DbPerson } from "./meeting";

/**
 * A segment's speaker label, as the om functions take it: "identified:<slug>"
 * for a known person, "person:<id>" for one with no slug, else as the golden
 * transcripts write it.
 */
export function labelOf(
  seg: Pick<Segment<number>, "speakerNumber" | "person">,
  people: ReadonlyMap<number, DbPerson>,
): string {
  if (seg.person !== null) {
    const slug = people.get(seg.person)?.slug;
    return slug ? `identified:${slug}` : `person:${seg.person}`;
  }
  if (seg.speakerNumber !== null) return `segmented:spk-${seg.speakerNumber}`;
  return "unlabeled";
}

/** The label, with the person's name and the speaker number when there are. */
function describeSpeaker(
  seg: Pick<Segment<number>, "speakerNumber" | "person">,
  people: ReadonlyMap<number, DbPerson>,
): string {
  const label = labelOf(seg, people);
  const extra = [
    seg.person === null ? null : (people.get(seg.person)?.name ?? "no name"),
    seg.person !== null && seg.speakerNumber !== null
      ? `spk-${seg.speakerNumber}`
      : null,
  ].filter(Boolean);
  return extra.length ? `${label} (${extra.join(", ")})` : label;
}

/**
 * The segments overlapping [from, to] (or just segment `seg`), each as a
 * header and one line per sentence, prefixed with its first word's onset.
 */
export function render(
  meeting: Pick<DbMeeting, "segments" | "people">,
  { from, to, seg }: { from?: number; to?: number; seg?: number } = {},
): string {
  const out: string[] = [];
  meeting.segments.forEach((s, i) => {
    const words = s.words;
    if (seg !== undefined && i !== seg) return;
    if (from !== undefined && words.at(-1)!.start < from) return;
    if (to !== undefined && words[0]!.start > to) return;
    out.push(
      `=== seg ${i} | ${describeSpeaker(s, meeting.people)} | ${formatClock(words[0]!.start)}-${formatClock(words.at(-1)!.start)} | ${words.length} words`,
    );
    let sentence: string[] = [];
    let start = 0;
    for (const w of words) {
      if (!sentence.length) start = w.start;
      sentence.push(w.text);
      if (/[.?!]$/.test(w.text)) {
        out.push(`[${formatClock(start)}] ${sentence.join(" ")}`);
        sentence = [];
      }
    }
    if (sentence.length)
      out.push(`[${formatClock(start)}] ${sentence.join(" ")}`);
    out.push("");
  });
  return out.join("\n");
}

/** Every word with an onset in [from, to], marking where segments start. */
export function wordList(
  meeting: Pick<DbMeeting, "segments" | "people">,
  from: number,
  to: number,
): string {
  const out: string[] = [];
  for (const s of meeting.segments) {
    s.words.forEach((w, i) => {
      if (w.start < from || w.start > to) return;
      const marker =
        i === 0 ? `   <-- starts ${labelOf(s, meeting.people)}` : "";
      out.push(`${formatClock(w.start)} ${w.text}${marker}`);
    });
  }
  return out.join("\n");
}

/** Segments and words per speaker, then the longest segments. */
export function stats(meeting: Pick<DbMeeting, "segments" | "people">): string {
  const bySpeaker = new Map<string, { segs: number; words: number }>();
  for (const s of meeting.segments) {
    const key = describeSpeaker(
      { ...s, speakerNumber: s.person === null ? s.speakerNumber : null },
      meeting.people,
    );
    const entry = bySpeaker.get(key) ?? { segs: 0, words: 0 };
    entry.segs++;
    entry.words += s.words.length;
    bySpeaker.set(key, entry);
  }
  const out = [...bySpeaker]
    .sort((a, b) => b[1].words - a[1].words)
    .map(
      ([key, { segs, words }]) =>
        `${key.padEnd(55)} ${String(segs).padStart(4)} segs ${String(words).padStart(6)} words`,
    );
  out.push("longest:");
  const longest = meeting.segments
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.words.length - a.s.words.length)
    .slice(0, 15);
  for (const { s, i } of longest)
    out.push(
      `  seg ${i} ${labelOf(s, meeting.people)} ${formatClock(s.words[0]!.start)} ${s.words.length} words`,
    );
  return out.join("\n");
}

/** A database meeting as the meeting rules take it. */
export function ruleMeeting(meeting: DbMeeting): RuleMeeting {
  return {
    title: meeting.title,
    description: meeting.description,
    bodyCount: meeting.bodySlugs.length,
    durationSecs: meeting.durationSecs,
    segments: meeting.segments,
    chapters: meeting.chapters.length ? meeting.chapters : null,
  };
}

/**
 * The rules a meeting follows: every meeting's, and those its bodies opt into
 * with `_rules` in bodies.jsonl.
 */
export function ruleSpecs(
  meeting: Pick<DbMeeting, "bodySlugs">,
): ((typeof RULE_SPECS)[number] | (typeof BODY_RULE_SPECS)[number])[] {
  const codes = bodyRuleCodes(meeting.bodySlugs);
  return [
    ...RULE_SPECS,
    ...BODY_RULE_SPECS.filter((spec) => codes.includes(spec.code)),
  ];
}

/** What the meeting rules find in a meeting. */
export async function meetingIssues(
  meeting: DbMeeting,
): Promise<MeetingIssue[]> {
  return (await checkMeeting(
    ruleMeeting(meeting),
    ruleSpecs(meeting),
  )) as MeetingIssue[];
}

/** An issue as "seg 12 0:03:04.50: error: message (code)". */
export function formatIssue(
  issue: MeetingIssue,
  meeting: Pick<DbMeeting, "segments" | "chapters">,
): string {
  let where = "meeting";
  if ("segmentIndex" in issue) {
    const seg = meeting.segments[issue.segmentIndex];
    const word =
      "wordIndex" in issue && issue.wordIndex >= 0
        ? seg?.words[issue.wordIndex]
        : seg?.words[0];
    where = `seg ${issue.segmentIndex}${word ? ` ${formatClock(word.start)}` : ""}`;
  } else if ("chapterIndex" in issue) {
    const chapter = meeting.chapters[issue.chapterIndex];
    where = `chapter ${issue.chapterIndex}${chapter ? ` ${formatClock(chapter.start)}` : ""}`;
  }
  return `${where}: ${issue.severity}: ${issue.message} (${issue.code})`;
}

/** The issues in `after` that `before` doesn't have, by code and message. */
export function newIssues(
  before: readonly MeetingIssue[],
  after: readonly MeetingIssue[],
): MeetingIssue[] {
  const seen = new Map<string, number>();
  const key = (i: MeetingIssue) => `${i.code}\n${i.message}`;
  for (const i of before) seen.set(key(i), (seen.get(key(i)) ?? 0) + 1);
  return after.filter((i) => {
    const n = seen.get(key(i)) ?? 0;
    if (n > 0) {
      seen.set(key(i), n - 1);
      return false;
    }
    return true;
  });
}
