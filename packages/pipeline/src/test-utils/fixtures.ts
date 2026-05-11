import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { timestampInSeconds } from "@gbos/core/timeline";

const FIXTURES_ROOT = new URL("../../test-fixtures/", import.meta.url).pathname;

export interface SpeakerEntry {
  slug: string;
  display_name: string;
}

export interface InterestingSegment {
  start: number;
  end: number;
  speaker_id: string;
  text: string;
  notes?: string;
}

export interface GoldenFile {
  meeting_id: number;
  source: { type: "youtube"; id: string };
  audio_sha256: string;
  duration_sec: number;
  interesting_segments: InterestingSegment[];
}

export interface MeetingFixture {
  meeting_id: number;
  municipality: string;
  fixtureDir: string;
  golden: GoldenFile;
}

type InterestingSegmentRaw = Omit<InterestingSegment, "start" | "end"> & { start: number | string; end: number | string };
type GoldenFileRaw = Omit<GoldenFile, "interesting_segments"> & { interesting_segments: InterestingSegmentRaw[] };



function loadInterestingSegment(raw: InterestingSegmentRaw) {
  const result = {
    ...raw,
    start: timestampInSeconds(raw.start),
    end: timestampInSeconds(raw.end),
  };
  // if (result.start >= result.end) {
  //   throw new Error(`Invalid segment with start >= end for raw segment: ${JSON.stringify(raw)}`);
  // }
  return result;
}

function loadGoldenFile(path: string): GoldenFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as GoldenFileRaw;
  return {
    ...raw,
    interesting_segments: raw.interesting_segments.map(loadInterestingSegment),
  };
}

export function loadAllFixtures(): MeetingFixture[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  const fixtures: MeetingFixture[] = [];
  for (const muni of listDirs(FIXTURES_ROOT)) {
    const muniDir = join(FIXTURES_ROOT, muni);
    for (const meetingDirName of listDirs(muniDir)) {
      const fixtureDir = join(muniDir, meetingDirName);
      const goldenPath = join(fixtureDir, "golden.json");
      if (!existsSync(goldenPath)) continue;
      const golden = loadGoldenFile(goldenPath);
      fixtures.push({
        meeting_id: golden.meeting_id,
        municipality: muni,
        fixtureDir,
        golden,
      });
    }
  }
  return fixtures;
}

export function getMeetingFixture(meeting_id: number): MeetingFixture {
  const found = loadAllFixtures().find((f) => f.meeting_id === meeting_id);
  if (!found) {
    throw new Error(`No fixture found for meeting_id ${meeting_id}`);
  }
  return found;
}

export function loadSpeakers(municipality: string): SpeakerEntry[] {
  const path = join(FIXTURES_ROOT, municipality, "speakers.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as SpeakerEntry[];
}

function listDirs(parent: string): string[] {
  return readdirSync(parent).filter((entry) => {
    const p = join(parent, entry);
    return statSync(p).isDirectory();
  });
}
