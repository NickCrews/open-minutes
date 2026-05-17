import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_ROOT = new URL("../../test-fixtures/", import.meta.url).pathname;

// DB-shaped row types (mirrors schema.ts columns that are relevant to fixtures).
// Fields prefixed with _ are test-only and do not exist in the DB.

export interface GoldenMunicipality {
  name: string;
  name_short: string;
  state: string;
  youtube_channel_id: string;
}

export interface GoldenPerson {
  slug: string;
  name: string;
}

export interface GoldenMeeting {
  youtube_id: string;
  title: string;
  duration_secs: number;
  /** SHA-256 of the canonical WAV file — used to validate the audio cache. Not a DB column. */
  _audio_sha256: string;
}

export interface GoldenWord {
  text: string;
  start: number;
  end: number;
}

export interface GoldenSegment {
  person_slug: string | null;
  text: string;
  start_secs: number;
  end_secs: number;
  words: GoldenWord[] | null;
  /** When true, this segment's text has been hand-verified and is used for WER spot-checks. */
  _curated?: boolean;
}

export interface MeetingFixture {
  municipality_slug: string;
  meeting_dir: string;
  fixtureDir: string;
  municipality: GoldenMunicipality;
  people: GoldenPerson[];
  meeting: GoldenMeeting;
  segments: GoldenSegment[];
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function loadAllFixtures(): MeetingFixture[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  const fixtures: MeetingFixture[] = [];

  for (const muniSlug of listDirs(FIXTURES_ROOT)) {
    const muniDir = join(FIXTURES_ROOT, muniSlug);

    const muniPath = join(muniDir, "municipalities.jsonl");
    if (!existsSync(muniPath)) continue;
    const [municipality] = parseJsonl<GoldenMunicipality>(muniPath);
    if (!municipality) continue;

    const peoplePath = join(muniDir, "people.jsonl");
    const people = existsSync(peoplePath) ? parseJsonl<GoldenPerson>(peoplePath) : [];

    for (const meetingDir of listDirs(muniDir)) {
      const fixtureDir = join(muniDir, meetingDir);
      const meetingsPath = join(fixtureDir, "meetings.jsonl");
      if (!existsSync(meetingsPath)) continue;

      const [meeting] = parseJsonl<GoldenMeeting>(meetingsPath);
      if (!meeting) continue;

      const segmentsPath = join(fixtureDir, "segments.jsonl");
      const segments = existsSync(segmentsPath) ? parseJsonl<GoldenSegment>(segmentsPath) : [];

      fixtures.push({
        municipality_slug: muniSlug,
        meeting_dir: meetingDir,
        fixtureDir,
        municipality,
        people,
        meeting,
        segments,
      });
    }
  }

  return fixtures;
}

export function getMeetingFixture(youtube_id: string): MeetingFixture {
  const found = loadAllFixtures().find((f) => f.meeting.youtube_id === youtube_id);
  if (!found) throw new Error(`No fixture found for youtube_id ${youtube_id}`);
  return found;
}

function listDirs(parent: string): string[] {
  return readdirSync(parent).filter((entry) => statSync(join(parent, entry)).isDirectory());
}
