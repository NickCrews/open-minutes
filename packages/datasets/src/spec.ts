import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "@open-minutes/fixtures/test-data";

// A dataset is declared by a JSON file in specs/, named for the dataset: which
// of the test data's rows to seed. Every dataset seeds all the jurisdictions
// and bodies; a spec says which meetings go with them, which recordings, which
// people, and where their voiceprints come from.

export const SPECS_DIR = new URL("../specs/", import.meta.url).pathname;

export interface DatasetSpec {
  /** What the dataset is for. Not seeded. */
  description: string;
  /** Golden meeting slugs, in id order, or "all" of them. */
  meetings: string[];
  /**
   * "meetings" (the default): only the recordings of `meetings`. "all": every
   * recording in recordings.jsonl, including those that aren't meetings.
   */
  recordings: "all" | "meetings";
  /**
   * "all": everyone in people.jsonl, plus anyone the meetings identify who
   * isn't listed. "speakers": only the people the meetings identify.
   */
  people: "all" | "speakers";
  /**
   * "placeholder": distinct deterministic vectors, fine for browsing but
   * meaningless for recognition. "audio": real ones, computed from the
   * meetings' audio; slow the first time.
   */
  voiceprints: "placeholder" | "audio";
}

const KEYS = ["description", "meetings", "recordings", "people", "voiceprints"];

/** The names of the datasets in specs/, sorted. */
export function datasetNames(): string[] {
  return readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Every golden meeting's slug, sorted. */
export function allMeetingSlugs(): string[] {
  const dir = join(TEST_DATA_ROOT, "meetings");
  return readdirSync(dir)
    .filter((slug) => existsSync(join(dir, slug, "meeting.json")))
    .sort();
}

/**
 * Read and check specs/<name>.json (see parseSpec), resolving `"meetings": "all"` to every
 * golden meeting. A spec with no meetings may leave out `people` and
 * `voiceprints`.
 */
export function loadSpec(name: string): DatasetSpec {
  const path = join(SPECS_DIR, `${name}.json`);
  if (!existsSync(path))
    throw new Error(
      `No dataset "${name}". Datasets: ${datasetNames().join(", ")} ` +
        `(packages/datasets/specs/).`,
    );
  return parseSpec(JSON.parse(readFileSync(path, "utf8")), path);
}

/** Check a parsed spec; `source` names it in errors. */
export function parseSpec(json: unknown, source: string): DatasetSpec {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json))
    fail("a spec must be a JSON object");
  const raw = json as Record<string, unknown>;

  for (const key of Object.keys(raw))
    if (!KEYS.includes(key))
      fail(`unknown key "${key}"; keys are ${KEYS.join(", ")}`);
  if (typeof raw.description !== "string" || !raw.description.trim())
    fail("description must be a non-empty string");

  let meetings: string[];
  if (raw.meetings === "all") meetings = allMeetingSlugs();
  else if (
    Array.isArray(raw.meetings) &&
    raw.meetings.every((m) => typeof m === "string")
  ) {
    meetings = raw.meetings as string[];
    const known = new Set(allMeetingSlugs());
    for (const slug of meetings)
      if (!known.has(slug)) fail(`no golden meeting "${slug}"`);
    if (new Set(meetings).size !== meetings.length)
      fail("meetings has a duplicate");
  } else meetings = fail('meetings must be "all" or a list of meeting slugs');

  const recordings = raw.recordings ?? "meetings";
  if (recordings !== "all" && recordings !== "meetings")
    fail('recordings must be "all" or "meetings"');

  if (meetings.length === 0) {
    if (raw.people !== undefined || raw.voiceprints !== undefined)
      fail("people and voiceprints need meetings");
    return {
      description: raw.description as string,
      meetings,
      recordings: recordings as DatasetSpec["recordings"],
      people: "speakers",
      voiceprints: "placeholder",
    };
  }
  if (raw.people !== "all" && raw.people !== "speakers")
    fail('people must be "all" or "speakers"');
  if (raw.voiceprints !== "placeholder" && raw.voiceprints !== "audio")
    fail('voiceprints must be "placeholder" or "audio"');
  return {
    description: raw.description as string,
    meetings,
    recordings: recordings as DatasetSpec["recordings"],
    people: raw.people as DatasetSpec["people"],
    voiceprints: raw.voiceprints as DatasetSpec["voiceprints"],
  };
}
