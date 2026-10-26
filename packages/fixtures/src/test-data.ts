import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Chapter } from "@open-minutes/core/chapters";
import type { Segment } from "@open-minutes/core/transcript";
import { parsePsv, parseTimestamp } from "./psv";
import type { MeetingSource } from "@open-minutes/core/meeting-source";
import { ianaTimezoneError } from "@open-minutes/core/timezone";
import {
  type MeetingWhen,
  parseMeetingDate,
  parseMeetingTime,
} from "@open-minutes/core/meeting-date";

/** Hand-verified golden fixtures: evals, benchmarks, tests. */
export const TEST_DATA_ROOT = new URL("../test-data/", import.meta.url)
  .pathname;

// DB-shaped row types (mirrors schema.ts columns that are relevant to fixtures).
// Fields prefixed with _ are test-only and do not exist in the DB.

export interface GoldenJurisdiction {
  /** As in `jurisdictions.slug`, eg "moa". */
  slug: string;
  name: string;
  state: string;
}

export interface GoldenBody {
  /** As in `bodies.slug`, eg "gbos". */
  slug: string;
  /** Slug of the jurisdiction this body sits inside (eg "moa"). */
  jurisdiction_slug: string;
  name: string;
  name_short: string;
  /** IANA zone the body meets in, eg "America/Anchorage". */
  timezone: string;
  /** As in `bodies.meeting_source`; absent for a body nobody scans. */
  meeting_source?: MeetingSource;
  /**
   * Codes of the body-specific rules its transcripts follow, from
   * BODY_RULE_SPECS in @open-minutes/core/rules, eg ["bill-number"]. Not a DB
   * column.
   */
  _rules?: string[];
}

export interface GoldenPerson {
  slug: string;
  name: string;
  /** Free-form background, as in `people.bio`. */
  bio?: string;
}

export interface GoldenMeeting {
  /** The fixture's directory name, eg "gbos-2026-03-23": `meetings.slug`. */
  slug: string;
  /**
   * Slugs of the bodies that held it (eg ["gbos"], or ["gbos", "luc"]
   * for a joint meeting), as in `meeting_bodies`. At least one.
   */
  body_slugs: string[];
  /** IANA zone `date` and `time` read in (eg "America/Anchorage"). */
  timezone: string;
  /** Every fixture meeting is a YouTube video: `meetings.site_id`. */
  youtube_id: string;
  title: string;
  /**
   * "YYYY-MM-DD" in `timezone`, or null if unknown. Optional in
   * meeting.json (absent means unknown); always present once loaded.
   */
  date: string | null;
  /** "HH:MM:SS" in `timezone`, or null if unknown. */
  time: string | null;
  duration_secs: number;
  segments: Segment<string>[];
  /** The meeting's chapters, from chapters.json; null if it has none. */
  chapters: GoldenChapters | null;
  meetingDir: string; // path to the meeting's fixture directory (used internally for loading audio and PSV)
  /** SHA-256 of the canonical WAV file — used to validate the audio cache. Not a DB column. */
  _audio_sha256: string;
}
/** Who or what wrote a meeting's chapters, as in `chapter_generations`. */
export interface GoldenChapterGeneration {
  model: string;
  prompt_version: string;
  reviewed_by_human: boolean;
}

/**
 * A meeting's chapters.json: one generation's chapters, in order. Times are
 * "H:MM:SS.ss" in the file and seconds once loaded.
 */
export interface GoldenChapters {
  generation: GoldenChapterGeneration;
  chapters: Chapter[];
}

export interface TestData {
  jurisdictions: GoldenJurisdiction[];
  bodies: GoldenBody[];
  people: GoldenPerson[];
  meetings: GoldenMeeting[];
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadAllTestData(root: string = TEST_DATA_ROOT): TestData {
  if (!existsSync(root)) throw new Error(`Fixtures root not found: ${root}`);

  const jurisdictionsPath = join(root, "jurisdictions.jsonl");
  if (!existsSync(jurisdictionsPath))
    throw new Error(`Jurisdictions file not found: ${jurisdictionsPath}`);
  const jurisdictions = parseJsonl<GoldenJurisdiction>(jurisdictionsPath);

  const bodiesPath = join(root, "bodies.jsonl");
  if (!existsSync(bodiesPath))
    throw new Error(`Bodies file not found: ${bodiesPath}`);
  const bodies = parseJsonl<GoldenBody>(bodiesPath);

  const peoplePath = join(root, "people.jsonl");
  if (!existsSync(peoplePath))
    throw new Error(`People file not found: ${peoplePath}`);
  const people = parseJsonl<GoldenPerson>(peoplePath);

  const meetingsDir = join(root, "meetings");
  if (!existsSync(meetingsDir))
    throw new Error(`Meetings directory not found: ${meetingsDir}`);
  const meetingSlugs = listDirs(meetingsDir);
  const meetings = meetingSlugs.map((slug) => getMeetingData(slug, root));

  return {
    jurisdictions,
    bodies,
    people,
    meetings,
  };
}

/**
 * Load just the people registry (people.jsonl) without touching meetings. Unlike
 * {@link loadAllTestData}, this never parses any golden.psv, so it stays usable
 * while a meeting fixture is mid-generation (meeting.json present, golden.psv not
 * yet written).
 */
export function loadPeople(): GoldenPerson[] {
  const peoplePath = join(TEST_DATA_ROOT, "people.jsonl");
  if (!existsSync(peoplePath))
    throw new Error(`People file not found: ${peoplePath}`);
  return parseJsonl<GoldenPerson>(peoplePath);
}

/**
 * The codes of the body-specific rules a meeting's transcript follows: those
 * its bodies opt into with `_rules`.
 */
export function bodyRuleCodes(
  bodySlugs: readonly string[],
  root: string = TEST_DATA_ROOT,
): string[] {
  const bodies = parseJsonl<GoldenBody>(join(root, "bodies.jsonl"));
  const codes = bodySlugs.flatMap(
    (slug) => bodies.find((b) => b.slug === slug)?._rules ?? [],
  );
  return [...new Set(codes)];
}

/**
 * Load just the bodies (bodies.jsonl), without parsing any transcripts. For
 * tests that need a golden body's identifiers but not the whole snapshot.
 */
export function loadBodies(): GoldenBody[] {
  const bodiesPath = join(TEST_DATA_ROOT, "bodies.jsonl");
  if (!existsSync(bodiesPath))
    throw new Error(`Bodies file not found: ${bodiesPath}`);
  return parseJsonl<GoldenBody>(bodiesPath);
}

/** Load just the jurisdictions (jurisdictions.jsonl). */
export function loadJurisdictions(): GoldenJurisdiction[] {
  const path = join(TEST_DATA_ROOT, "jurisdictions.jsonl");
  if (!existsSync(path))
    throw new Error(`Jurisdictions file not found: ${path}`);
  return parseJsonl<GoldenJurisdiction>(path);
}

/**
 * A meeting directory's transcript: golden.psv for a verified golden meeting,
 * transcript.psv for an unverified one. Undefined when it has neither.
 */
export function transcriptPath(meetingDir: string): string | undefined {
  return ["golden.psv", "transcript.psv"]
    .map((file) => join(meetingDir, file))
    .find((path) => existsSync(path));
}

export function getMeetingData(
  meetingSlug: string,
  root: string = TEST_DATA_ROOT,
): GoldenMeeting {
  const meetingDir = join(root, "meetings", meetingSlug);
  if (!existsSync(meetingDir))
    throw new Error(`Meeting directory not found: ${meetingDir}`);
  const meetingPath = join(meetingDir, "meeting.json");
  if (!existsSync(meetingPath))
    throw new Error(`Meeting file not found: ${meetingPath}`);
  const meeting = parseJson<GoldenMeeting>(meetingPath);
  const when = parseGoldenWhen(meeting, meetingPath);
  const body_slugs = parseGoldenBodies(meeting, meetingPath);
  const timezoneError =
    typeof meeting.timezone === "string"
      ? ianaTimezoneError(meeting.timezone)
      : "timezone must be a string";
  if (timezoneError) throw new Error(`${meetingPath}: ${timezoneError}`);

  const psvPath = transcriptPath(meetingDir);
  if (!psvPath)
    throw new Error(`No golden.psv or transcript.psv in ${meetingDir}`);
  const segments = parsePsv({ path: psvPath });

  const chaptersPath = join(meetingDir, "chapters.json");
  const chapters = existsSync(chaptersPath)
    ? parseGoldenChapters(parseJson(chaptersPath), chaptersPath)
    : null;

  return {
    ...meeting,
    ...when,
    body_slugs,
    slug: meetingSlug,
    meetingDir,
    segments,
    chapters,
  };
}

/**
 * Validate a meeting.json's `body_slugs`: one or more distinct body slugs. Whether
 * each names a body in bodies.jsonl is checked where they're resolved (see
 * `meetingBodyIds`).
 */
export function parseGoldenBodies(
  raw: { body_slugs?: unknown },
  source: string,
): string[] {
  const slugs = raw.body_slugs;
  if (!Array.isArray(slugs) || !slugs.every((s) => typeof s === "string"))
    throw new Error(`${source}: body_slugs must be an array of strings`);
  if (slugs.length === 0) throw new Error(`${source}: body_slugs is empty`);
  if (new Set(slugs).size !== slugs.length)
    throw new Error(`${source}: body_slugs has duplicates`);
  return slugs;
}

/**
 * Validate and normalize a meeting.json's `date`/`time` (both optional; "HH:MM"
 * is accepted for time). Throws on a malformed value rather than seeding
 * garbage, and on a time with no date, which the database would refuse anyway.
 */
export function parseGoldenWhen(
  raw: { date?: unknown; time?: unknown },
  source: string,
): MeetingWhen {
  const field = (
    name: "date" | "time",
    parse: (v: string) => string | null,
  ): string | null => {
    const value = raw[name];
    if (value == null) return null;
    const parsed = typeof value === "string" ? parse(value) : null;
    if (parsed === null)
      throw new Error(`${source}: invalid ${name} ${JSON.stringify(value)}`);
    return parsed;
  };
  const date = field("date", parseMeetingDate);
  const time = field("time", parseMeetingTime);
  if (time !== null && date === null)
    throw new Error(`${source}: has a time but no date`);
  return { date, time };
}

/**
 * Validate a chapters.json and convert its "H:MM:SS.ss" times to seconds.
 * Checks shape only; whether the chapters are any good is for the tests.
 */
export function parseGoldenChapters(
  raw: unknown,
  source: string,
): GoldenChapters {
  const fail = (what: string): never => {
    throw new Error(`${source}: ${what}`);
  };
  const obj = (raw ?? {}) as Record<string, unknown>;
  const gen = (obj.generation ?? fail("missing generation")) as Record<
    string,
    unknown
  >;
  if (typeof gen.model !== "string") fail("generation.model must be a string");
  if (typeof gen.prompt_version !== "string")
    fail("generation.prompt_version must be a string");
  if (typeof gen.reviewed_by_human !== "boolean")
    fail("generation.reviewed_by_human must be a boolean");
  if (!Array.isArray(obj.chapters)) fail("chapters must be an array");
  const chapters = (obj.chapters as Record<string, unknown>[]).map((c, i) => {
    const where = `chapters[${i}]`;
    for (const key of ["start", "end", "title", "summary"] as const) {
      if (typeof c[key] !== "string") fail(`${where}.${key} must be a string`);
    }
    if (
      !Array.isArray(c.bullets) ||
      !c.bullets.every((b) => typeof b === "string")
    )
      fail(`${where}.bullets must be an array of strings`);
    const time = (key: "start" | "end") => {
      const secs = parseTimestamp(c[key] as string);
      if (!Number.isFinite(secs)) fail(`${where}.${key} is not H:MM:SS.ss`);
      return secs;
    };
    return {
      start: time("start"),
      end: time("end"),
      title: c.title as string,
      summary: c.summary as string,
      bullets: c.bullets as string[],
    };
  });
  return {
    generation: {
      model: gen.model as string,
      prompt_version: gen.prompt_version as string,
      reviewed_by_human: gen.reviewed_by_human as boolean,
    },
    chapters,
  };
}

function listDirs(parent: string): string[] {
  return readdirSync(parent).filter((entry) =>
    statSync(join(parent, entry)).isDirectory(),
  );
}
