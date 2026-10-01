import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  chapterErrors,
  chapterWarnings,
  uncoveredSpeech,
} from "@open-minutes/core/chapters";
import { selfIntroductions } from "@open-minutes/core/self-introductions";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { formatTimestamp, parsePsv, parseTimestamp } from "./psv";
import {
  DEV_DATA_ROOT,
  type GoldenPerson,
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
  roots: readonly string[] = [TEST_DATA_ROOT, DEV_DATA_ROOT],
): string[] {
  return roots.flatMap((root) => {
    const dir = join(root, "meetings");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isDirectory());
  });
}

/** Everyone in the people.jsonl files under the given data roots. */
export function loadAllPeople(
  roots: readonly string[] = [TEST_DATA_ROOT, DEV_DATA_ROOT],
): GoldenPerson[] {
  return roots.flatMap((root) => {
    const path = join(root, "people.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as GoldenPerson);
  });
}

/** Check every fixture meeting: its transcript and its chapters. */
export function checkFixtures(
  dirs: readonly string[] = meetingDirs(),
  people: readonly GoldenPerson[] = loadAllPeople(),
): Issue[] {
  return dirs.flatMap((dir) => checkMeetingDir(dir, people));
}

/** Check one meeting directory. */
export function checkMeetingDir(
  dir: string,
  people: readonly GoldenPerson[] = loadAllPeople(),
): Issue[] {
  const issues: Issue[] = [];
  const psvPath = ["golden.psv", "transcript.psv"]
    .map((f) => join(dir, f))
    .find((p) => existsSync(p));
  if (psvPath) {
    issues.push(...checkPsv(readFileSync(psvPath, "utf8"), psvPath, people));
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
 * Lint a PSV transcript. Errors: lines the parser refuses, words out of time
 * order, a speaker marker not on the same onset as the word after it (the
 * usual sign of a marker inserted a line off), and a speaker marker with no
 * words. Warnings: a speaker labelled as one known person who introduces
 * themselves as another. (Unidentified speakers who introduce themselves
 * aren't flagged: some goldens are deliberately left unidentified.)
 */
export function checkPsv(
  content: string,
  file: string,
  people: readonly GoldenPerson[] = [],
): Issue[] {
  const issues: Issue[] = [];
  const issue = (line: number, severity: Severity, message: string) =>
    issues.push({ file, line, severity, message });

  try {
    parsePsv(content);
  } catch (err) {
    const message = (err as Error).message;
    const line = /line (\d+)/.exec(message)?.[1];
    issue(line ? Number(line) : 1, "error", message);
    return issues;
  }

  type Word = { line: number; text: string };
  type Seg = { line: number; label: string; words: Word[] };
  const segs: Seg[] = [];
  let pendingMeta: { line: number; start: number } | undefined;
  let lastOnset = -Infinity;
  content.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const [startField, type, ...rest] = raw.trim().split("|");
    if (!raw.trim() || raw.startsWith("#") || startField === "start_sec")
      return;
    const start = parseTimestamp(startField!);
    const data = rest.join("|");
    if (type === "meta") {
      if (pendingMeta)
        issue(
          pendingMeta.line,
          "error",
          "speaker marker with no words after it",
        );
      pendingMeta = { line, start };
      const label = (JSON.parse(data) as { begin_speaker: string })
        .begin_speaker;
      segs.push({ line, label, words: [] });
    } else if (type === "text") {
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
      segs.at(-1)?.words.push({ line, text: data });
    }
  });
  if (pendingMeta)
    issue(pendingMeta.line, "error", "speaker marker with no words after it");

  for (const seg of segs) {
    if (!seg.label.startsWith("identified:")) continue;
    for (const intro of selfIntroductions(seg.words, people)) {
      const line = seg.words[intro.word]!.line;
      if (seg.label === `identified:${intro.person.slug}`) continue;
      issue(
        line,
        "warning",
        `speaker says "${intro.phrase}" but is labelled ${seg.label}; should this be identified:${intro.person.slug}? (if the speaker changes partway through, split the segment)`,
      );
    }
  }
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
