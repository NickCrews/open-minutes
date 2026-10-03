import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { meetingsTable, segmentsTable } from "@open-minutes/db";
import {
  CLEANING_RULES,
  cleanSpeechSegments,
  type DiarizationTurn,
  type SpeechSegment,
} from "@open-minutes/core/transcription";
import { transcriptFingerprint } from "@open-minutes/core/transcript-fingerprint";
import { ALL_MODEL_SPECS } from "../all-models";
import { transcribeAudio } from "../transcribe";
import { computeSpeakerEmbeddings } from "../embed";
import { diarizeAudio } from "../diarize";
import { alignSpeakers, segmentsToTurns } from "../align";
import { identifyAndInsertSegments } from "../identify";
import { openingText, resolveMeetingDateTime } from "../meeting_date";
import type { Step } from "./steps";

/**
 * The transcript step's version. Bump it whenever a change would make the
 * pipeline write a different transcript for the same audio: a new model, a
 * cleaning rule, a threshold in diarization, alignment or recognition. Every
 * meeting transcribed at an older version then shows as stale (`om status`),
 * and `om pending --stale` lists them for reprocessing. See ADR 0005.
 *
 * A test pins this together with the models and cleaning rules, so changing
 * those without bumping it fails.
 */
export const TRANSCRIPT_VERSION = "1";

/** What a transcript run records it was made with, beyond the commit. */
export function transcriptInputs() {
  return {
    models: ALL_MODEL_SPECS.map((m) => m.name),
    cleaningRules: CLEANING_RULES.map((r) => r.name),
  };
}

/** On-disk shape of a work directory's diarization.json. */
interface DiarizationArtifact {
  turns: DiarizationTurn[];
}

/**
 * On-disk shape of embeddings.json: one voiceprint centroid per local speaker.
 * An array rather than a keyed object so the speaker number stays a number —
 * JSON object keys are always strings.
 */
type EmbeddingsArtifact = Array<{ speaker: number; centroid: number[] }>;

/**
 * Make a meeting's transcript: download → transcribe → clean → diarize →
 * align → recognize. Also refreshes the meeting's metadata from the video
 * (discovery only records what a channel listing shows) and works out when
 * the meeting happened from its title and opening words.
 *
 * Each stage's output is cached as a file in the meeting's work directory; a
 * stage whose artifact already exists is skipped, so an interrupted run
 * resumes from the last completed stage. Nothing is written to the database
 * until every stage has succeeded, and then all at once: a reprocessed
 * meeting's segments are replaced in the same transaction.
 */
export const transcriptStep: Step = {
  name: "transcript",
  version: TRANSCRIPT_VERSION,
  after: [],
  async run({ meeting, yt, workDir }) {
    const youtubeId = meeting.youtubeId;
    console.error(`[${youtubeId}] fetching video metadata...`);
    const metadata = await yt.getMetadata(youtubeId);

    await mkdir(workDir, { recursive: true });
    const audioPath = join(workDir, "audio.wav");
    if (existsSync(audioPath)) {
      console.error(`[${youtubeId}] audio.wav exists, skipping download`);
    } else {
      await yt.ensureAudioDownloaded(youtubeId, audioPath);
    }

    const rawSpeechSegments = await cachedStage<SpeechSegment[]>(
      youtubeId,
      join(workDir, "transcription.json"),
      () => transcribeAudio(audioPath),
    );
    // Strip disfluencies (fillers, stutters, ...). Deliberately not cached:
    // transcription.json stays the recognizer's verbatim output, so a new or
    // changed cleaning rule applies on the next run without re-transcribing.
    const speechSegments = cleanSpeechSegments(rawSpeechSegments);

    // When the meeting happened: the title's date, the chair's gavel-in time.
    // The upload date supplies the year when neither states one.
    const when = resolveMeetingDateTime(
      metadata.title,
      openingText(speechSegments),
      { uploadDate: metadata.uploadDate ?? undefined },
    );
    console.error(
      `[${youtubeId}] meeting date ${when.date ?? "unknown"} (from ${when.dateSource ?? "nothing"}), ` +
        `start ${when.time ?? "unknown"} (from ${when.timeSource ?? "nothing"})`,
    );
    for (const warning of when.warnings) {
      console.error(`[${youtubeId}] WARNING: ${warning}`);
    }

    const diarization = await cachedStage<DiarizationArtifact>(
      youtubeId,
      join(workDir, "diarization.json"),
      () => ({ turns: diarizeAudio(audioPath) }),
    );

    // Transcription and diarization are both raw, and both wrong in places:
    // the recognizer drops audio, and clustering wobbles mid-utterance.
    // Combining them is what produces our best account of who said what and
    // when, so everything downstream works from the aligned segments rather
    // than either raw input.
    const segments = alignSpeakers(speechSegments, diarization.turns).filter(
      (segment) => segment.words.length > 0,
    );

    // Voiceprints come from the cleaned segments, not the raw diarization
    // turns.
    const embeddings = await cachedStage<EmbeddingsArtifact>(
      youtubeId,
      join(workDir, "embeddings.json"),
      () =>
        [...computeSpeakerEmbeddings(audioPath, segmentsToTurns(segments))].map(
          ([speaker, centroid]) => ({
            speaker,
            centroid: Array.from(centroid),
          }),
        ),
    );
    const speakerEmbeddings = new Map(
      embeddings.map(({ speaker, centroid }) => [
        speaker,
        Float32Array.from(centroid),
      ]),
    );

    return {
      details: {
        ...transcriptInputs(),
        segments: segments.length,
        speakers: speakerEmbeddings.size,
        transcriptFingerprint: transcriptFingerprint(segments),
        dateSource: when.dateSource,
        timeSource: when.timeSource,
      },
      summary: `${segments.length} segment(s), meeting date ${when.date ?? "unknown"}`,
      async write(tx) {
        console.error(
          `[${youtubeId}] committing ${segments.length} segment(s)...`,
        );
        await tx
          .update(meetingsTable)
          .set({
            title: metadata.title,
            description: metadata.description,
            // Parsed from the title and the chair's gavel-in (see
            // meeting_date.ts), not YouTube publish/stream times, which don't
            // reliably reflect when the meeting happened. A time without a
            // date is meaningless.
            date: when.date,
            time: when.date ? when.time : null,
            duration_secs:
              metadata.durationSecs === null
                ? null
                : sql`make_interval(secs => ${metadata.durationSecs})`,
          })
          .where(eq(meetingsTable.id, meeting.id));
        // Reprocessing replaces the transcript. Recognition matches the new
        // speakers to the people the old segments named, by voice, so who
        // said what survives; hand edits to the segments themselves don't.
        await tx
          .delete(segmentsTable)
          .where(eq(segmentsTable.meeting_id, meeting.id));
        await identifyAndInsertSegments(
          tx,
          meeting.id,
          segments,
          speakerEmbeddings,
        );
      },
    };
  },
};

/**
 * Run a pipeline stage with a JSON file cache: if `artifactPath` exists, load
 * it and skip the computation; otherwise compute and persist it.
 */
async function cachedStage<T>(
  youtubeId: string,
  artifactPath: string,
  compute: () => Promise<T> | T,
): Promise<T> {
  const artifactName = artifactPath.split("/").at(-1)!;
  if (existsSync(artifactPath)) {
    console.error(`[${youtubeId}] ${artifactName} exists, skipping stage`);
    return JSON.parse(await readFile(artifactPath, "utf8")) as T;
  }
  const result = await compute();
  await writeFile(artifactPath, JSON.stringify(result, null, 2));
  return result;
}
