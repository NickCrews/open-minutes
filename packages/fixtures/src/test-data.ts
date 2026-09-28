import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type GoldenSegment, parsePsv } from "./psv";

const TEST_DATA_ROOT = new URL("../test-data/", import.meta.url).pathname;

// DB-shaped row types (mirrors schema.ts columns that are relevant to fixtures).
// Fields prefixed with _ are test-only and do not exist in the DB.

export interface GoldenJurisdiction {
  id: string;
  name: string;
  name_short: string;
  state: string;
}

export interface GoldenVideoSource {
  kind: "channel" | "playlist";
  youtube_id: string;
}

export interface GoldenBody {
  id: string;
  /** Snapshot id of the jurisdiction this body sits inside (eg "moa"). */
  jurisdiction_id: string;
  name: string;
  name_short: string;
  /** IANA zone the body meets in, eg "America/Anchorage". */
  timezone: string;
  video_sources: GoldenVideoSource[];
}

export interface GoldenPerson {
  slug: string;
  name: string;
}

export interface GoldenMeeting {
  body_id: string;
  youtube_id: string;
  title: string;
  duration_secs: number;
  segments: GoldenSegment[];
  meetingDir: string; // path to the meeting's fixture directory (used internally for loading audio and PSV)
  /** SHA-256 of the canonical WAV file — used to validate the audio cache. Not a DB column. */
  _audio_sha256: string;
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

export function loadAllTestData(): TestData {
  if (!existsSync(TEST_DATA_ROOT))
    throw new Error(`Fixtures root not found: ${TEST_DATA_ROOT}`);

  const jurisdictionsPath = join(TEST_DATA_ROOT, "jurisdictions.jsonl");
  if (!existsSync(jurisdictionsPath))
    throw new Error(`Jurisdictions file not found: ${jurisdictionsPath}`);
  const jurisdictions = parseJsonl<GoldenJurisdiction>(jurisdictionsPath);

  const bodiesPath = join(TEST_DATA_ROOT, "bodies.jsonl");
  if (!existsSync(bodiesPath))
    throw new Error(`Bodies file not found: ${bodiesPath}`);
  const bodies = parseJsonl<GoldenBody>(bodiesPath);

  const peoplePath = join(TEST_DATA_ROOT, "people.jsonl");
  if (!existsSync(peoplePath))
    throw new Error(`People file not found: ${peoplePath}`);
  const people = parseJsonl<GoldenPerson>(peoplePath);

  const meetingsDir = join(TEST_DATA_ROOT, "meetings");
  if (!existsSync(meetingsDir))
    throw new Error(`Meetings directory not found: ${meetingsDir}`);
  const meetingSlugs = listDirs(meetingsDir);
  const meetings = meetingSlugs.map((slug) => getMeetingData(slug));

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

export function getMeetingData(meetingSlug: string): GoldenMeeting {
  const meetingDir = join(TEST_DATA_ROOT, "meetings", meetingSlug);
  if (!existsSync(meetingDir))
    throw new Error(`Meeting directory not found: ${meetingDir}`);
  const meetingPath = join(meetingDir, "meeting.json");
  if (!existsSync(meetingPath))
    throw new Error(`Meeting file not found: ${meetingPath}`);
  const meeting = parseJson<GoldenMeeting>(meetingPath);

  const segments = parsePsv({ path: join(meetingDir, "golden.psv") });

  return {
    ...meeting,
    meetingDir,
    segments,
  };
}

function listDirs(parent: string): string[] {
  return readdirSync(parent).filter((entry) =>
    statSync(join(parent, entry)).isDirectory(),
  );
}
