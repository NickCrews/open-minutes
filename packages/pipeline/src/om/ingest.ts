import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/core/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { realYouTube, type YouTube } from "@open-minutes/core/youtube";
import type {
  DiarizationTurn,
  SpeechSegment,
} from "@open-minutes/core/transcription";
import { transcribeAudio } from "../transcribe";
import { computeSpeakerEmbeddings, diarizeAudio } from "../diarize";
import { alignSpeakers, segmentsToTurns } from "../align";
import { identifyAndInsertSegments } from "../identify";

/**
 * Root of the per-meeting work directories (one `<body-slug>_<youtubeId>` dir
 * per meeting, holding each stage's artifact for inspection and resume).
 * Lives at packages/pipeline/data/meetings/, gitignored via the root `data/`
 * rule.
 */
export const DEFAULT_WORK_ROOT = fileURLToPath(
  new URL("../../data/meetings/", import.meta.url),
);

export interface IngestOptions {
  /** YouTube boundary, injectable for tests. Defaults to the real yt-dlp one. */
  yt?: YouTube;
  /** Where per-meeting work directories live. Defaults to {@link DEFAULT_WORK_ROOT}. */
  workRoot?: string;
}

export type IngestResult =
  | {
    youtubeId: string;
    status: "ingested";
    meetingId: number;
    segmentCount: number;
  }
  | { youtubeId: string; status: "skipped" };

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
 * Run the full pipeline for one video — download → transcribe → diarize →
 * align → identify — and commit the meeting to the database.
 *
 * Each stage's output is cached as a file in the meeting's work directory; a
 * stage whose artifact already exists is skipped, so an interrupted run
 * resumes from the last completed stage. The database commit is all-or-nothing:
 * the meeting row and all its segments are inserted in a single transaction
 * only after every stage has succeeded, so partially processed meetings never
 * appear in queries.
 *
 * An already-ingested video is skipped (returns `status: "skipped"`); a video
 * whose channel matches no known body is an error.
 */
export async function ingestVideo(
  db: DB,
  youtubeId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const yt = options.yt ?? realYouTube;
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;

  const existing = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(eq(meetingsTable.youtube_id, youtubeId))
    .limit(1);
  if (existing.length > 0) {
    console.error(`[${youtubeId}] already ingested, skipping`);
    return { youtubeId, status: "skipped" };
  }

  console.error(`[${youtubeId}] fetching video metadata...`);
  const metadata = await yt.fetchVideoMetadata(youtubeId);
  const body = await resolveBody(db, youtubeId, metadata.channelId);

  const workDir = join(workRoot, `${bodySlug(body)}_${youtubeId}`);
  await mkdir(workDir, { recursive: true });

  const audioPath = join(workDir, "audio.wav");
  if (existsSync(audioPath)) {
    console.error(`[${youtubeId}] audio.wav exists, skipping download`);
  } else {
    await yt.downloadVideoAudio(youtubeId, audioPath);
  }

  const speechSegments = await cachedStage<SpeechSegment[]>(
    youtubeId,
    join(workDir, "transcription.json"),
    () => transcribeAudio(audioPath),
  );

  const diarization = await cachedStage<DiarizationArtifact>(
    youtubeId,
    join(workDir, "diarization.json"),
    () => ({ turns: diarizeAudio(audioPath) }),
  );

  // Transcription and diarization are both raw, and both wrong in places: the
  // recognizer drops audio, and clustering wobbles mid-utterance. Combining
  // them is what produces our best account of who said what and when, so everything
  // downstream works from the aligned segments rather than either raw input.
  const words = speechSegments.flatMap((s) => s.words);
  const segments = alignSpeakers(words, diarization.turns).filter(
    (segment) => segment.words.length > 0,
  );

  // Voiceprints come from the cleaned segments, not the raw diarization turns.
  const embeddings = await cachedStage<EmbeddingsArtifact>(
    youtubeId,
    join(workDir, "embeddings.json"),
    () =>
      [...computeSpeakerEmbeddings(audioPath, segmentsToTurns(segments))].map(
        ([speaker, centroid]) => ({ speaker, centroid: Array.from(centroid) }),
      ),
  );
  const speakerEmbeddings = new Map(
    embeddings.map(({ speaker, centroid }) => [
      speaker,
      Float32Array.from(centroid),
    ]),
  );

  const segmentsWithNormedSpeaker = segments.map((segment) => ({
    speaker:
      segment.speaker.type === "segmented"
        ? segment.speaker.speakerNumber
        : null,
    words: segment.words,
  }));

  console.error(
    `[${youtubeId}] committing meeting with ${segmentsWithNormedSpeaker.length} segment(s)...`,
  );
  const meetingId = await db.transaction(async (tx) => {
    const [meeting] = await tx
      .insert(meetingsTable)
      .values({
        body_id: body.id,
        youtube_id: youtubeId,
        title: metadata.title,
        description: metadata.description,
        // start_time is left null: YouTube publish/stream times don't reliably
        // reflect when the meeting actually happened.
        duration_secs:
          metadata.durationSecs === null
            ? null
            : sql`make_interval(secs => ${metadata.durationSecs})`,
      })
      .returning({ id: meetingsTable.id });
    await identifyAndInsertSegments(
      tx,
      meeting!.id,
      segmentsWithNormedSpeaker,
      speakerEmbeddings,
    );
    return meeting!.id;
  });

  return {
    youtubeId,
    status: "ingested",
    meetingId,
    segmentCount: segmentsWithNormedSpeaker.length,
  };
}

export interface IngestBatchSummary {
  results: IngestResult[];
  failures: Array<{ youtubeId: string; error: unknown }>;
}

/**
 * Ingest a batch of videos sequentially, continuing past individual failures.
 * Each failure is logged to stderr; the summary reports every outcome so the
 * caller can decide the exit status.
 */
export async function ingestVideos(
  db: DB,
  youtubeIds: string[],
  options: IngestOptions = {},
): Promise<IngestBatchSummary> {
  const results: IngestResult[] = [];
  const failures: IngestBatchSummary["failures"] = [];
  for (const youtubeId of youtubeIds) {
    try {
      results.push(await ingestVideo(db, youtubeId, options));
    } catch (error) {
      console.error(`[${youtubeId}] FAILED: ${describeError(error)}`);
      failures.push({ youtubeId, error });
    }
  }
  return { results, failures };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveBody(db: DB, youtubeId: string, channelId: string) {
  if (channelId) {
    const [body] = await db
      .select({
        id: bodiesTable.id,
        name: bodiesTable.name,
        name_short: bodiesTable.name_short,
      })
      .from(bodiesTable)
      .innerJoin(
        videoSourcesTable,
        eq(videoSourcesTable.body_id, bodiesTable.id),
      )
      .where(eq(videoSourcesTable.youtube_id, channelId))
      .limit(1);
    if (body) return body;
  }
  throw new Error(
    `Video ${youtubeId} is on channel "${channelId}", which matches no ` +
    `body's video sources. Refusing to ingest an unrelated video.`,
  );
}

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
