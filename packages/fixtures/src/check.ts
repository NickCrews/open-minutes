import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  chapterErrors,
  chapterWarnings,
  uncoveredSpeech,
} from "@open-minutes/core/chapters";
import {
  LAST_WORD_DURATION_SEC,
  splitSentences,
} from "@open-minutes/core/transcription";
import { cleanGoldenSegments } from "./clean";
import {
  formatTimestamp,
  parsePsv,
  parseTimestamp,
  sameSpeakerLabel,
} from "./psv";
import {
  getMeetingData,
  parseGoldenChapters,
  TEST_DATA_ROOT,
} from "./test-data";

// Checks over the hand-edited fixture files, reported against file and line
// so whoever made an edit (often an agent) can go straight to the mistake.
// Errors are data that is wrong; warnings are data that is probably wrong, or
// breaks a convention, and wants a look. The fixture tests fail on either, and
// `pnpm fixtures:check` prints both.

export type Severity = "error" | "warning";

export interface Issue {
  file: string;
  /** 1-based; absent when the problem is with the file as a whole. */
  line?: number;
  severity: Severity;
  message: string;
}

/** `file:line: severity: message`, relative to `cwd`, as editors link it. */
export function formatIssue(issue: Issue, cwd = process.cwd()): string {
  const where =
    relative(cwd, issue.file) + (issue.line ? `:${issue.line}` : "");
  return `${where}: ${issue.severity}: ${issue.message}`;
}

/** Every fixture meeting directory under the given data roots. */
export function meetingDirs(
  roots: readonly string[] = [TEST_DATA_ROOT],
): string[] {
  return roots.flatMap((root) => {
    const dir = join(root, "meetings");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isDirectory());
  });
}

/** Check every fixture meeting: its transcript and its chapters. */
export function checkFixtures(
  dirs: readonly string[] = meetingDirs(),
): Issue[] {
  return dirs.flatMap((dir) => checkMeetingDir(dir));
}

/** Check one meeting directory. */
export function checkMeetingDir(dir: string): Issue[] {
  const issues: Issue[] = [];
  const psvPath = ["golden.psv", "transcript.psv"]
    .map((f) => join(dir, f))
    .find((p) => existsSync(p));
  if (psvPath) {
    issues.push(...checkPsv(readFileSync(psvPath, "utf8"), psvPath));
  }
  // Whatever the loader itself refuses (meeting.json, PSV syntax, the shape
  // of chapters.json), reported once rather than cascading.
  let segments: ReturnType<typeof parsePsv> | undefined;
  try {
    const meeting = getMeetingData(
      dir.split(/[\\/]/).at(-1)!,
      resolve(dir, "../.."),
    );
    segments = meeting.segments;
    const slugIssue = checkMeetingSlug(meeting);
    if (slugIssue)
      issues.push({ file: dir, severity: "warning", message: slugIssue });
  } catch (err) {
    const message = (err as Error).message;
    if (!issues.some((i) => i.severity === "error"))
      issues.push({ file: dir, severity: "error", message });
    return issues;
  }
  const chaptersPath = join(dir, "chapters.json");
  if (existsSync(chaptersPath)) {
    issues.push(
      ...checkChapters(
        readFileSync(chaptersPath, "utf8"),
        chaptersPath,
        segments,
      ),
    );
  }
  return issues;
}

/**
 * A meeting's slug (its directory name) is `<body>-<date>`, eg
 * "gbos-2026-03-23", plus a "-<suffix>" to tell apart two meetings of one
 * body on one day; just `<body>-<suffix>` when the date is unknown. A joint
 * meeting can go by any of its bodies.
 */
export function checkMeetingSlug(meeting: {
  slug: string;
  body_ids: string[];
  date: string | null;
}): string | null {
  const stems = meeting.body_ids.map((body) =>
    meeting.date ? `${body}-${meeting.date}` : body,
  );
  for (const stem of stems) {
    const rest = meeting.slug.startsWith(stem)
      ? meeting.slug.slice(stem.length)
      : null;
    if (
      rest !== null &&
      (/^-[a-z0-9-]+$/.test(rest) || (meeting.date && !rest))
    )
      return null;
  }
  const want = meeting.date ? stems[0]! : `${stems[0]!}-<suffix>`;
  return `Meeting directory "${meeting.slug}" should be named "${want}" (<body>-<date>): it's the meeting's slug in the database`;
}

/**
 * Lint a PSV transcript. Errors: lines the parser refuses, words out of time
 * order, a speaker marker not on the same onset as the word after it (the
 * usual sign of a marker inserted a line off), a speaker marker with no
 * words, and disfluencies the pipeline's clean stage would have removed
 * ("um", "the the"; see clean.ts). Warnings: a speaker change inside a
 * sentence, a few words from a clearly longer pause (see turn-edges.ts).
 */
export function checkPsv(content: string, file: string): Issue[] {
  const issues: Issue[] = [];
  const issue = (line: number, severity: Severity, message: string) =>
    issues.push({ file, line, severity, message });

  let segments: ReturnType<typeof parsePsv>;
  try {
    segments = parsePsv(content);
  } catch (err) {
    const message = (err as Error).message;
    const line = /line (\d+)/.exec(message)?.[1];
    issue(line ? Number(line) : 1, "error", message);
    return issues;
  }

  let pendingMeta: { line: number; start: number } | undefined;
  let lastOnset = -Infinity;
  // The line of each word onset, to place the disfluency errors. By onset
  // alone: a cleaning rule may report a word after an earlier rule recased it.
  const wordLines = new Map<number, number>();
  // The line of each speaker marker; the n-th opens the n-th segment.
  const metaLines: number[] = [];
  content.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const [startField, type] = raw.trim().split("|");
    if (!raw.trim() || raw.startsWith("#") || startField === "start_sec")
      return;
    const start = parseTimestamp(startField!);
    if (type === "meta") {
      metaLines.push(line);
      if (pendingMeta)
        issue(
          pendingMeta.line,
          "error",
          "speaker marker with no words after it",
        );
      pendingMeta = { line, start };
    } else if (type === "text") {
      if (!wordLines.has(start)) wordLines.set(start, line);
      if (start < lastOnset)
        issue(
          line,
          "error",
          `word onset ${startField} is before the previous word's (${formatTimestamp(lastOnset)}); words must be in time order`,
        );
      lastOnset = start;
      if (pendingMeta && pendingMeta.start !== start)
        issue(
          pendingMeta.line,
          "error",
          `speaker marker at ${formatTimestamp(pendingMeta.start)} but its first word starts at ${startField}; a marker goes on the line just before its first word, with the same onset`,
        );
      pendingMeta = undefined;
    }
  });
  if (pendingMeta)
    issue(pendingMeta.line, "error", "speaker marker with no words after it");

  for (const c of cleanGoldenSegments(segments).changes) {
    if (c.after !== null) continue; // a knock-on fix, eg a passed-on capital
    issue(
      wordLines.get(c.start) ?? 1,
      "error",
      `${c.rule} ${JSON.stringify(c.before)} should not be in a transcript; run \`pnpm fixtures:clean\``,
    );
  }

  for (const split of splitSentences(segments)) {
    const seg = segments[split.segment]!;
    if (sameSpeakerLabel(segments[split.segment - 1]!.speaker, seg.speaker))
      continue;
    const moved = split.misplaced.map((w) => w.text).join(" ");
    issue(
      metaLines[split.segment]!,
      "warning",
      `speaker change at ${formatTimestamp(split.start)} splits a sentence; the pause at ${formatTimestamp(split.edgeStart)} is longer (${split.edgePause}s vs ${split.pause}s), so ${JSON.stringify(moved)} may belong to the other speaker. Move the marker to the sentence edge where the voice changes`,
    );
  }
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return issues;
}

/**
 * Check a chapters.json against its meeting's transcript, with the rules in
 * @open-minutes/core/chapters: errors for chapters that are out of order,
 * overlapping or outside the meeting; warnings for broken size conventions
 * and for speech no chapter covers.
 */
export function checkChapters(
  content: string,
  file: string,
  segments: ReturnType<typeof parsePsv>,
): Issue[] {
  const issues: Issue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    const message = (err as Error).message;
    const pos = /position (\d+)/.exec(message)?.[1];
    const line = pos
      ? content.slice(0, Number(pos)).split("\n").length
      : undefined;
    return [{ file, line, severity: "error", message }];
  }
  let parsed: ReturnType<typeof parseGoldenChapters>;
  try {
    parsed = parseGoldenChapters(raw, file);
  } catch (err) {
    return [{ file, severity: "error", message: (err as Error).message }];
  }
  const { chapters } = parsed;

  // The n-th `"start":` key is the n-th chapter's.
  const chapterLines: number[] = [];
  content.split("\n").forEach((l, i) => {
    if (/^\s*"start"\s*:/.test(l)) chapterLines.push(i + 1);
  });
  const at = (c: number, severity: Severity, message: string) =>
    issues.push({
      file,
      line: chapterLines[c],
      severity,
      message: `chapter ${c + 1} ("${chapters[c]?.title}") ${message}`,
    });

  const speech = segments
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
    }));
  const speechEnd = Math.max(0, ...speech.map((s) => s.end));

  for (const e of chapterErrors(chapters, speechEnd))
    at(e.chapter, "error", e.message);
  for (const w of chapterWarnings(chapters))
    at(w.chapter, "warning", w.message);
  for (const gap of uncoveredSpeech(speech, chapters)) {
    const before = chapters.filter((c) => c.end <= gap.start).length - 1;
    issues.push({
      file,
      line: chapterLines[Math.max(0, before)],
      severity: "warning",
      message: `speech from ${formatTimestamp(gap.start)} to ${formatTimestamp(gap.end)} is in no chapter; extend a neighbouring chapter or add one`,
    });
  }
  return issues;
}
