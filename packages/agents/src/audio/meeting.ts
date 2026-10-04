import { asc, eq } from "drizzle-orm";
import { peopleTable, segmentsTable } from "@open-minutes/db";
import { readWave, type WaveForm } from "@open-minutes/audio/wav";
import {
  getCachedAudio,
  meetingCacheDir,
} from "@open-minutes/ingest/audio-cache";
import {
  LAST_WORD_DURATION_SEC,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { youtubeIdOf } from "@open-minutes/core/meeting-source";
import { findMeeting, type MeetingRef } from "../meeting-ref";
import { type Db, ToolError } from "../tool";

/**
 * A run of words by one speaker, as the audio tools see it: the same shape
 * whether it came from the database or a test clip's PSV.
 */
export interface LabeledSegment {
  /** The segment's row id (a test clip's: its index in the PSV). */
  id: number;
  /**
   * Who it's attributed to: "person:<slug>" (or "person:<id>" for an
   * anonymous person), "speaker:<n>", or "unattributed". (A test clip's: its
   * PSV label, eg "identified:kellie-okonek".)
   */
  label: string;
  /** Onset of the first word. */
  start: number;
  /** Onset of the last word plus {@link LAST_WORD_DURATION_SEC}. */
  end: number;
  words: TranscriptWord[];
}

/** A meeting's audio and transcript, for the audio tools. */
export interface AudioMeeting {
  /** What the caller passed: a meeting slug or id. */
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

/**
 * Open a meeting by slug ("gbos-2026-03-23") or id (12), from the database.
 * Downloads its audio into the per-machine cache the tests use on first use.
 */
export async function openMeeting(
  ref: MeetingRef,
  db: Db,
): Promise<AudioMeeting> {
  const { youtubeId, segments } = await loadFromDb(db, ref);
  // No sha256 check: the audio only has to line up in time with the
  // transcript, and the store's audio does.
  const audio = await getCachedAudio({ youtubeId });
  let wave: WaveForm | null = null;
  return {
    ref: String(ref),
    youtubeId,
    audioPath: audio.path,
    cacheDir: meetingCacheDir(youtubeId),
    segments,
    wave: () => (wave ??= readWave(audio.path)),
  };
}

async function loadFromDb(db: Db, ref: MeetingRef) {
  const meeting = await findMeeting(db, ref);
  // The audio cache only knows YouTube's audio.
  const youtubeId = youtubeIdOf(meeting);
  if (!youtubeId)
    throw new ToolError(
      `Meeting ${ref} is on ${meeting.site}; the audio tools only work with YouTube meetings`,
    );
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
    .where(eq(segmentsTable.meeting_id, meeting.id))
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
  return { youtubeId, segments };
}

export function toLabeled(
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
