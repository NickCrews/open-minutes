import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type CheckedMeeting,
  type CheckedSegment,
  CHAPTER_CHECKERS,
  checkMeeting,
  type MeetingIssue,
  TRANSCRIPT_CHECKERS,
} from "@open-minutes/core/meeting-check";
import { formatClock } from "@open-minutes/core/clock";
import {
  formatSpeaker,
  type GoldenSegment,
  parsePsv,
  parseTimestamp,
} from "./psv";
import {
  type GoldenMeeting,
  getMeetingData,
  parseGoldenChapters,
  TEST_DATA_ROOT,
} from "./test-data";

// Checks over the hand-edited fixture files, reported against file and line
// so whoever made an edit (often an agent) can go straight to the mistake.
// A meeting's data follows the rules in @open-minutes/core/meeting-check, the
// same ones the database is checked against; this adds the rules for the
// files themselves (PSV syntax, where a speaker marker goes, the directory
// name). Errors fail the fixture tests and `pnpm fixtures:check`; warnings are
// printed and want a look.

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
export async function checkFixtures(
  dirs: readonly string[] = meetingDirs(),
): Promise<Issue[]> {
  return (await Promise.all(dirs.map((dir) => checkMeetingDir(dir)))).flat();
}

/** Check one meeting directory. */
export async function checkMeetingDir(dir: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const psvPath = ["golden.psv", "transcript.psv"]
    .map((f) => join(dir, f))
    .find((p) => existsSync(p));
  const psv = psvPath
    ? readPsv(readFileSync(psvPath, "utf8"), psvPath)
    : undefined;
  if (psv) issues.push(...psv.issues);
  // Whatever the loader itself refuses (meeting.json, PSV syntax, the shape
  // of chapters.json), reported once rather than cascading.
  let meeting: ReturnType<typeof getMeetingData>;
  try {
    meeting = getMeetingData(dir.split(/[\\/]/).at(-1)!, resolve(dir, "../.."));
  } catch (err) {
    const message = (err as Error).message;
    if (!issues.some((i) => i.severity === "error"))
      issues.push({ file: dir, severity: "error", message });
    return issues;
  }
  const slugIssue = checkMeetingSlug(meeting);
  if (slugIssue)
    issues.push({ file: dir, severity: "warning", message: slugIssue });

  const chaptersPath = join(dir, "chapters.json");
  const chapterLines = meeting.chapters
    ? chapterStartLines(readFileSync(chaptersPath, "utf8"))
    : [];
  const chapters = meeting.chapters?.chapters ?? null;
  const placed = (await checkMeeting(checkedMeeting(meeting))).map((i) =>
    "segment" in i
      ? atPsvLine(i, psvPath!, psv!.lines)
      : i.code === "no-bodies"
        ? {
            file: join(dir, "meeting.json"),
            severity: i.severity,
            message: i.message,
          }
        : atChapterLine(i, chaptersPath, chapterLines, chapters ?? []),
  );
  issues.push(...placed);
  return issues.sort((a, b) =>
    a.file === b.file
      ? (a.line ?? 0) - (b.line ?? 0)
      : a.file < b.file
        ? -1
        : 1,
  );
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

/** Where each segment's marker and words are in a PSV file, by 1-based line. */
interface PsvLines {
  markers: number[];
  words: number[][];
}

/**
 * Parse a PSV file and check what only a file can get wrong: its syntax, and
 * a speaker marker not on the same onset as the word after it (the usual sign
 * of a marker inserted a line off).
 */
function readPsv(
  content: string,
  file: string,
): { issues: Issue[]; segments?: GoldenSegment[]; lines: PsvLines } {
  const issues: Issue[] = [];
  const lines: PsvLines = { markers: [], words: [] };
  let segments: GoldenSegment[];
  try {
    segments = parsePsv(content);
  } catch (err) {
    const message = (err as Error).message;
    const line = /line (\d+)/.exec(message)?.[1];
    issues.push({
      file,
      line: line ? Number(line) : 1,
      severity: "error",
      message,
    });
    return { issues, lines };
  }

  let pendingMeta: { line: number; start: number } | undefined;
  content.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const [startField, type] = raw.trim().split("|");
    if (!raw.trim() || raw.startsWith("#") || startField === "start_sec")
      return;
    const start = parseTimestamp(startField!);
    if (type === "meta") {
      lines.markers.push(line);
      lines.words.push([]);
      pendingMeta = { line, start };
    } else if (type === "text") {
      lines.words.at(-1)!.push(line);
      if (pendingMeta && pendingMeta.start !== start)
        issues.push({
          file,
          line: pendingMeta.line,
          severity: "error",
          message: `speaker marker at ${formatClock(pendingMeta.start)} but its first word starts at ${startField}; a marker goes on the line just before its first word, with the same onset`,
        });
      pendingMeta = undefined;
    }
  });
  return { issues, segments, lines };
}

/** A golden meeting as the meeting rules take it. */
export function checkedMeeting(meeting: GoldenMeeting): CheckedMeeting {
  return {
    bodyCount: meeting.body_ids.length,
    durationSecs: meeting.duration_secs,
    segments: checkedSegments(meeting.segments),
    chapters: meeting.chapters?.chapters ?? null,
  };
}

/** Golden segments as the meeting rules take them. */
function checkedSegments(segments: readonly GoldenSegment[]): CheckedSegment[] {
  return segments.map((s) => ({
    speaker: s.speaker.kind === "unlabeled" ? null : formatSpeaker(s.speaker),
    words: s.words,
  }));
}

/** A transcript issue at its line in the PSV file, worded for that file. */
function atPsvLine(
  issue: Extract<MeetingIssue, { segment: number }>,
  file: string,
  lines: PsvLines,
): Issue {
  const s = issue.segment;
  const line =
    "word" in issue && issue.word >= 0
      ? lines.words[s]![issue.word]
      : lines.markers[s];
  const message =
    issue.code === "empty-segment"
      ? "speaker marker with no words after it"
      : issue.code === "unclean-word"
        ? `${issue.message}; run \`pnpm fixtures:clean\``
        : issue.message;
  return { file, line, severity: issue.severity, message };
}

/** The line of each chapter's `"start":` key in a chapters.json. */
function chapterStartLines(content: string): number[] {
  const lines: number[] = [];
  content.split("\n").forEach((l, i) => {
    if (/^\s*"start"\s*:/.test(l)) lines.push(i + 1);
  });
  return lines;
}

/**
 * A chapter issue at its chapter's line; uncovered speech at the chapter
 * before it.
 */
function atChapterLine(
  issue: Extract<MeetingIssue, { at: number }>,
  file: string,
  lines: readonly number[],
  chapters: readonly { end: number }[],
): Issue {
  const chapter =
    "chapter" in issue
      ? issue.chapter
      : Math.max(0, chapters.filter((c) => c.end <= issue.at).length - 1);
  return {
    file,
    line: lines[chapter],
    severity: issue.severity,
    message: issue.message,
  };
}

/**
 * Check a PSV transcript on its own: the file's syntax and speaker markers,
 * and the transcript rules in @open-minutes/core/meeting-check.
 */
export async function checkPsv(
  content: string,
  file: string,
): Promise<Issue[]> {
  const { issues, segments, lines } = readPsv(content, file);
  if (segments)
    for (const i of await checkMeeting(
      { segments: checkedSegments(segments) },
      TRANSCRIPT_CHECKERS,
    ))
      if ("segment" in i) issues.push(atPsvLine(i, file, lines));
  return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Check a chapters.json against its meeting's transcript, with the chapter
 * rules in @open-minutes/core/meeting-check.
 */
export async function checkChapters(
  content: string,
  file: string,
  segments: readonly GoldenSegment[],
  durationSecs?: number,
): Promise<Issue[]> {
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
  const lines = chapterStartLines(content);
  const found = await checkMeeting(
    { segments: checkedSegments(segments), chapters, durationSecs },
    CHAPTER_CHECKERS,
  );
  return found
    .flatMap((i) =>
      "at" in i ? [atChapterLine(i, file, lines, chapters)] : [],
    )
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
