import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATUMS_ROOT } from "./datums";

// A dataset is a combination of datums, declared by a JSON file in datasets/
// named for it. Every dataset holds all the jurisdictions and bodies; its file
// says which meetings go with them, which people, and where their voiceprints
// come from.

export const DATASETS_DIR = new URL("../datasets/", import.meta.url).pathname;

export interface Dataset {
  /** What the dataset is for. Not seeded. */
  description: string;
  /** Golden meeting slugs, in id order, or "all" of them. */
  meetings: string[];
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

const KEYS = ["description", "meetings", "people", "voiceprints"];

/** The names of the datasets in datasets/, sorted. */
export function datasetNames(): string[] {
  return readdirSync(DATASETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Every golden meeting's slug, sorted. */
export function allMeetingSlugs(): string[] {
  const dir = join(DATUMS_ROOT, "meetings");
  return readdirSync(dir)
    .filter((slug) => existsSync(join(dir, slug, "meeting.json")))
    .sort();
}

/**
 * Read and check datasets/<name>.json (see parseDataset), resolving
 * `"meetings": "all"` to every golden meeting. A dataset with no meetings may
 * leave out `people` and `voiceprints`.
 */
export function loadDataset(name: string): Dataset {
  const path = join(DATASETS_DIR, `${name}.json`);
  if (!existsSync(path))
    throw new Error(
      `No dataset "${name}". Datasets: ${datasetNames().join(", ")} ` +
        `(packages/datasets/datasets/).`,
    );
  return parseDataset(JSON.parse(readFileSync(path, "utf8")), path);
}

/** Check a parsed dataset file; `source` names it in errors. */
export function parseDataset(json: unknown, source: string): Dataset {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json))
    fail("a dataset must be a JSON object");
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

  if (meetings.length === 0) {
    if (raw.people !== undefined || raw.voiceprints !== undefined)
      fail("people and voiceprints need meetings");
    return {
      description: raw.description as string,
      meetings,
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
    people: raw.people as Dataset["people"],
    voiceprints: raw.voiceprints as Dataset["voiceprints"],
  };
}
