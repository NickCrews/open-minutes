import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import sherpa, { type WaveForm } from "sherpa-onnx-node";
import {
  type DB,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import {
  LAST_WORD_DURATION_SEC,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import {
  getMeetingData,
  TEST_DATA_ROOT,
} from "@open-minutes/fixtures/test-data";
import { getCachedAudio, meetingCacheDir } from "../test-utils/audio-cache";

/**
 * A run of words by one speaker, as the audio tools see it: the same shape
 * whether it came from a golden fixture or the database.
 */
export interface LabeledSegment {
  /**
   * How to refer to the segment: its index in file order for a golden (as
   * psvtool.py's `render` numbers them), its row id in the database.
   */
  id: number;
  /**
   * Who it's attributed to. A golden's label as written in the PSV
   * ("identified:kellie-okonek", "segmented:spk-3", "unlabeled"); in the
   * database "person:<slug>" (or "person:<id>" for an anonymous person),
   * "speaker:<n>", or "unattributed".
   */
  label: string;
  /** Onset of the first word. */
  start: number;
  /** Onset of the last word plus {@link LAST_WORD_DURATION_SEC}. */
  end: number;
  words: TranscriptWord[];
}

/** A meeting's audio and transcript, for the audio tools. */
export interface ListenMeeting {
  /** What the caller passed: a golden fixture name, or a database meeting id. */
  ref: string;
  youtubeId: string;
  /** 16 kHz mono WAV. */
  audioPath: string;
  /** Where derived artifacts (speech runs, voice timelines) are cached. */
  cacheDir: string;
  segments: LabeledSegment[];
  /** The decoded audio, read on first use and kept. */
  wave(): WaveForm;
}

/** The golden fixture names, eg "gbos_9HoIM5INxpI". */
export function goldenRefs(): string[] {
  const dir = join(TEST_DATA_ROOT, "meetings");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/**
 * Open a meeting by golden fixture name ("gbos_9HoIM5INxpI") or database
 * meeting id ("12"). Downloads its audio into the per-machine cache the tests
 * use on first use. `db` is only needed, and only opened, for a database id.
 */
export async function openMeeting(
  ref: string,
  getDb: () => Promise<DB>,
): Promise<ListenMeeting> {
  const { youtubeId, segments } = /^\d+$/.test(ref)
    ? await loadFromDb(await getDb(), Number(ref))
    : loadFromGolden(ref);
  // No sha256 check: the audio only has to line up in time with the
  // transcript, and the store's audio does.
  const audio = await getCachedAudio({ youtubeId });
  let wave: WaveForm | null = null;
  return {
    ref,
    youtubeId,
    audioPath: audio.path,
    cacheDir: meetingCacheDir(youtubeId),
    segments,
    wave: () => (wave ??= sherpa.readWave(audio.path)),
  };
}

function loadFromGolden(ref: string) {
  if (!existsSync(join(TEST_DATA_ROOT, "meetings", ref)))
    throw new ListenError(
      `No golden meeting "${ref}" and not a database meeting id. Golden meetings are the directory names under packages/fixtures/test-data/meetings/.`,
    );
  const meeting = getMeetingData(ref);
  const segments = meeting.segments
    .map((seg, id) => ({ seg, id }))
    .filter(({ seg }) => seg.words.length > 0)
    .map(({ seg, id }) => {
      const label =
        seg.speaker.kind === "identified"
          ? `identified:${seg.speaker.person}`
          : seg.speaker.kind === "segmented"
            ? `segmented:spk-${seg.speaker.cluster}`
            : "unlabeled";
      return toLabeled(id, label, seg.words);
    });
  return { youtubeId: meeting.youtube_id, segments };
}

async function loadFromDb(db: DB, meetingId: number) {
  const [meeting] = await db
    .select({ youtubeId: meetingsTable.youtube_id })
    .from(meetingsTable)
    .where(eq(meetingsTable.id, meetingId));
  if (!meeting) throw new ListenError(`No meeting ${meetingId}`);
  if (!meeting.youtubeId)
    throw new ListenError(`Meeting ${meetingId} has no YouTube video`);
  const rows = await db
    .select({
      id: segmentsTable.id,
      personId: segmentsTable.person_id,
      speakerNumber: segmentsTable.speaker_number,
      slug: peopleTable.slug,
      words: segmentsTable.words,
    })
    .from(segmentsTable)
    .leftJoin(peopleTable, eq(peopleTable.id, segmentsTable.person_id))
    .where(eq(segmentsTable.meeting_id, meetingId))
    .orderBy(asc(segmentsTable.start_secs), asc(segmentsTable.id));
  const segments = rows.map((r) => {
    const label =
      r.personId != null
        ? `person:${r.slug ?? r.personId}`
        : r.speakerNumber != null
          ? `speaker:${r.speakerNumber}`
          : "unattributed";
    return toLabeled(r.id, label, r.words);
  });
  return { youtubeId: meeting.youtubeId, segments };
}

function toLabeled(
  id: number,
  label: string,
  words: TranscriptWord[],
): LabeledSegment {
  return {
    id,
    label,
    start: words[0]!.start,
    end: words.at(-1)!.start + LAST_WORD_DURATION_SEC,
    words,
  };
}

/** A refused call: a bad reference or range. Printed as {"error": ...}. */
export class ListenError extends Error {
  override name = "ListenError";
}
