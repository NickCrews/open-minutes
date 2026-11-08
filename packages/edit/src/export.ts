// Export a meeting from a database as a golden meeting: its directory under
// datums/meetings/ (meeting.json, golden.psv, chapters.json) and its people's
// lines in people.jsonl. The files are generated: edit the meeting in the
// database and export it again.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Site } from "@open-minutes/core/site";
import type { Segment } from "@open-minutes/core/transcript";
import { sameSpeaker } from "@open-minutes/core/transcript-edit";
import {
  DATUMS_ROOT,
  type GoldenChapters,
  type GoldenPerson,
} from "@open-minutes/datasets/datums";
import { serializeChapters } from "@open-minutes/datasets/fix";
import { serializePsv } from "@open-minutes/datasets/psv";
import type { DbMeeting } from "./meeting";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** meeting.json, in the order its keys are written. */
export interface MeetingJson {
  body_slugs: string[];
  timezone: string;
  site: Site;
  external_id: string;
  title: string;
  date?: string;
  time?: string;
  duration_secs: number;
  _audio_sha256: string;
}

/** A meeting as the golden files hold it, but for its audio's hash. */
export interface Golden {
  slug: string;
  meeting: Omit<MeetingJson, "_audio_sha256">;
  segments: Segment<string>[];
  chapters: GoldenChapters | null;
  people: GoldenPerson[];
}

/**
 * A database meeting as a golden meeting. Throws, listing every problem, if
 * it can't be one: it needs a slug and a duration, and
 * everyone it names needs a slug and a name.
 */
export function toGolden(m: DbMeeting): Golden {
  const problems: string[] = [];
  if (!m.slug)
    problems.push(
      'the meeting has no slug: set one with a {"op":"meeting","slug":...} op',
    );
  if (m.durationSecs === null) problems.push("it has no duration");
  if (!m.bodySlugs.length) problems.push("it has no bodies");

  const segmentCounts = new Map<number, number>();
  for (const s of m.segments)
    if (s.person !== null)
      segmentCounts.set(s.person, (segmentCounts.get(s.person) ?? 0) + 1);
  const people: GoldenPerson[] = [];
  for (const [id, count] of segmentCounts) {
    const p = m.people.get(id);
    const who = `person ${id}${p?.name ? ` (${p.name})` : ""}, in ${count} segment(s),`;
    if (!p?.slug)
      problems.push(
        `${who} has no slug: give them one with a "person" op, or label their segments segmented:spk-<n>`,
      );
    else if (!p.name)
      problems.push(`${who} has no name: set one with a "person" op`);
    else
      people.push({
        slug: p.slug,
        name: p.name,
        ...(p.bio ? { bio: p.bio } : {}),
      });
  }
  if (problems.length)
    throw new Error(
      `Can't export meeting ${m.slug ?? m.id} as a golden:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );

  const segments: Segment<string>[] = [];
  for (const s of m.segments) {
    const seg: Segment<string> = {
      person: s.person === null ? null : m.people.get(s.person)!.slug!,
      speakerNumber: s.person === null ? s.speakerNumber : null,
      words: s.words.map((w) => ({ text: w.text, start: w.start })),
    };
    const last = segments.at(-1);
    if (last && sameSpeaker(last, seg)) last.words.push(...seg.words);
    else segments.push(seg);
  }

  return {
    slug: m.slug!,
    meeting: {
      body_slugs: m.bodySlugs,
      timezone: m.timezone,
      site: m.site,
      external_id: m.external_id,
      title: m.title,
      ...(m.date ? { date: m.date } : {}),
      ...(m.time ? { time: m.time.replace(/^(\d\d:\d\d):00$/, "$1") } : {}),
      duration_secs: m.durationSecs!,
    },
    segments,
    chapters: m.generation
      ? {
          generation: {
            model: m.generation.model,
            prompt_version: m.generation.prompt_version,
            reviewed_by_human: m.generation.reviewed_by_human,
          },
          chapters: m.chapters.map((c) => ({
            start: c.start,
            end: c.end,
            title: c.title,
            summary: c.summary,
            bullets: c.bullets,
          })),
        }
      : null,
    people: people.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/**
 * The sha256 of a recording's audio, to check later that the audio is the one
 * its transcript was timed against. Downloads it if it isn't cached.
 */
export async function audioSha256(
  site: Site,
  externalId: string,
): Promise<string> {
  const { getCachedAudio } = await import("@open-minutes/meeting-audio");
  const audio = await getCachedAudio({ site, id: externalId });
  return audio.manifest.sha256;
}

/**
 * Write a golden meeting's files under `root`, and its people's lines in
 * people.jsonl (replacing a line with the same slug, else appending). The
 * audio hash in an existing meeting.json for the same recording is kept;
 * otherwise `sha256` gives it. Returns the files written.
 */
export async function writeGolden(
  golden: Golden,
  {
    root = DATUMS_ROOT,
    sha256 = audioSha256,
  }: {
    root?: string;
    sha256?: (site: Site, externalId: string) => Promise<string>;
  } = {},
): Promise<string[]> {
  const dir = join(root, "meetings", golden.slug);
  mkdirSync(dir, { recursive: true });
  const meetingPath = join(dir, "meeting.json");
  const old = existsSync(meetingPath)
    ? (JSON.parse(readFileSync(meetingPath, "utf8")) as Partial<MeetingJson>)
    : {};
  const meeting: MeetingJson = {
    ...golden.meeting,
    _audio_sha256:
      old.site === golden.meeting.site &&
      old.external_id === golden.meeting.external_id &&
      old._audio_sha256
        ? old._audio_sha256
        : await sha256(golden.meeting.site, golden.meeting.external_id),
  };
  const written = [meetingPath];
  writeFileSync(meetingPath, JSON.stringify(meeting, null, 2) + "\n");

  const psvPath = join(dir, "golden.psv");
  serializePsv(golden.segments, { path: psvPath });
  written.push(psvPath);

  const chaptersPath = join(dir, "chapters.json");
  if (golden.chapters) {
    writeFileSync(chaptersPath, serializeChapters(golden.chapters));
    written.push(chaptersPath);
  } else if (existsSync(chaptersPath)) {
    rmSync(chaptersPath);
  }

  const peoplePath = join(root, "people.jsonl");
  const lines = existsSync(peoplePath)
    ? readFileSync(peoplePath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
    : [];
  const index = new Map(
    lines.map((l, i) => [(JSON.parse(l) as GoldenPerson).slug, i]),
  );
  for (const p of golden.people) {
    const line = JSON.stringify({ slug: p.slug, name: p.name, bio: p.bio });
    const i = index.get(p.slug);
    if (i === undefined) {
      index.set(p.slug, lines.length);
      lines.push(line);
    } else lines[i] = line;
  }
  writeFileSync(peoplePath, lines.join("\n") + "\n");
  written.push(peoplePath);

  format([meetingPath, ...(golden.chapters ? [chaptersPath] : [])]);
  return written;
}

/** Format files as `pnpm format` would, so they pass its check. */
function format(files: readonly string[]): void {
  const vp = join(REPO_ROOT, "node_modules", ".bin", "vp");
  const result = spawnSync(vp, ["fmt", ...files], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `vp fmt failed: ${result.stderr || result.stdout || result.error}`,
    );
}
