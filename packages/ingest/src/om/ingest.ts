import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingBodiesTable,
  meetingsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { type SiteKind, siteKindOf } from "@open-minutes/core/meeting-source";
import {
  alignSpeakers,
  cleanSpeechSegments,
  type DiarizationTurn,
  segmentsToTurns,
  type SpeechSegment,
} from "@open-minutes/core/transcription";
import { transcribeAudio } from "@open-minutes/audio/transcribe";
import { computeSpeakerEmbeddings } from "@open-minutes/audio/embed";
import { diarizeAudio } from "@open-minutes/audio/diarize";
import { identifyAndInsertSegments } from "../identify";
import {
  type MeetingDateTime,
  openingText,
  resolveMeetingDateTime,
} from "@open-minutes/core/meeting-date";
import {
  parseMeetingRef,
  type SiteMeeting,
  type Sites,
  withDefaultSites,
  workDirName,
} from "./sites";

/**
 * Root of the per-meeting work directories (one per meeting, named by
 * {@link workDirName}, eg `gbos_hTKVG_L61ec`, holding each stage's artifact for inspection and resume).
 * Lives at packages/ingest/data/meetings/, gitignored via the root `data/`
 * rule.
 */
export const DEFAULT_WORK_ROOT = fileURLToPath(
  new URL("../../data/meetings/", import.meta.url),
);

export interface IngestOptions {
  /**
   * Each site's metadata and audio, injectable for tests. Any not given come
   * from the environment (see {@link withDefaultSites}).
   */
  sites?: Partial<Sites>;
  /** Where per-meeting work directories live. Defaults to {@link DEFAULT_WORK_ROOT}. */
  workRoot?: string;
}

/**
 * A meeting to ingest: `ref` is a YouTube video ID or URL, or an akleg.gov
 * meeting ID or URL (see {@link parseMeetingRef}). `body` is the slug of the
 * body it belongs to (as `om available` gives it). Without one, it's the body
 * whose meeting source is the meeting's YouTube channel or akleg.gov
 * committee; a body whose source is a playlist has to be named.
 */
export interface MeetingToIngest {
  ref: string;
  body?: string;
}

/**
 * Meetings to ingest, one per line as `om available` prints them:
 * `<id>[\t<body slug>]`. An ID may hold spaces (akleg.gov's do), so only a tab
 * separates it from the body.
 */
export function parseMeetingLines(
  text: string,
  defaultBody?: string,
): MeetingToIngest[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref, body] = line.split("\t").map((part) => part.trim());
      return { ref: ref!, body: body || defaultBody };
    });
}

export type IngestResult = SiteMeeting &
  (
    | {
        status: "ingested";
        meetingId: number;
        segmentCount: number;
        /** When the meeting happened, read from its title and opening minutes. */
        when: MeetingDateTime;
      }
    | { status: "skipped" }
  );

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
 * Run the full pipeline for one meeting — download → transcribe → clean →
 * diarize → align → identify — and commit it to the database.
 *
 * Each stage's output is cached as a file in the meeting's work directory; a
 * stage whose artifact already exists is skipped, so an interrupted run
 * resumes from the last completed stage. The database commit is all-or-nothing:
 * the meeting row and all its segments are inserted in a single transaction
 * only after every stage has succeeded, so partially processed meetings never
 * appear in queries.
 *
 * An already-ingested meeting is skipped (returns `status: "skipped"`); a
 * meeting that belongs to no body is an error.
 */
export async function ingestMeeting(
  db: DB,
  meeting: MeetingToIngest | string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { ref, body: bodyArg } =
    typeof meeting === "string" ? { ref: meeting } : meeting;
  const { siteKind, siteId } = parseMeetingRef(ref);
  const provider = withDefaultSites(options.sites)[siteKind];
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  const tag = `[${siteId}]`;

  const existing = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(
      and(
        eq(meetingsTable.site_kind, siteKind),
        eq(meetingsTable.site_id, siteId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    console.error(`${tag} already ingested, skipping`);
    return { siteKind, siteId, status: "skipped" };
  }

  console.error(`${tag} fetching ${siteKind} metadata...`);
  const metadata = await provider.getMetadata(siteId);
  const body = await resolveBody(
    db,
    { siteKind, siteId },
    metadata.channelId,
    bodyArg,
  );

  const workDir = join(workRoot, workDirName(bodySlug(body), siteId));
  await mkdir(workDir, { recursive: true });

  const audioPath = join(workDir, "audio.wav");
  if (existsSync(audioPath)) {
    console.error(`${tag} audio.wav exists, skipping download`);
  } else {
    await provider.ensureAudioDownloaded(siteId, audioPath);
  }

  const rawSpeechSegments = await cachedStage<SpeechSegment[]>(
    tag,
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
    `${tag} meeting date ${when.date ?? "unknown"} (from ${when.dateSource ?? "nothing"}), ` +
      `start ${when.time ?? "unknown"} (from ${when.timeSource ?? "nothing"})`,
  );
  for (const warning of when.warnings) {
    console.error(`${tag} WARNING: ${warning}`);
  }

  const diarization = await cachedStage<DiarizationArtifact>(
    tag,
    join(workDir, "diarization.json"),
    () => ({ turns: diarizeAudio(audioPath) }),
  );

  // Transcription and diarization are both raw, and both wrong in places: the
  // recognizer drops audio, and clustering wobbles mid-utterance. Combining
  // them is what produces our best account of who said what and when, so everything
  // downstream works from the aligned segments rather than either raw input.
  const segments = alignSpeakers(speechSegments, diarization.turns).filter(
    (segment) => segment.words.length > 0,
  );

  // Voiceprints come from the cleaned segments, not the raw diarization turns.
  const embeddings = await cachedStage<EmbeddingsArtifact>(
    tag,
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

  console.error(
    `${tag} committing meeting with ${segments.length} segment(s)...`,
  );
  const meetingId = await db.transaction(async (tx) => {
    const [meeting] = await tx
      .insert(meetingsTable)
      .values({
        site_kind: siteKind,
        site_id: siteId,
        title: metadata.title,
        description: metadata.description,
        // Where the body meets; ingestion can't tell if this meeting was
        // somewhere else.
        timezone: body.timezone,
        // Parsed from the title and the chair's gavel-in (see @open-minutes/core/meeting-date),
        // not the site's publish/stream times, which don't reliably reflect when
        // the meeting happened. A time without a date is meaningless.
        date: when.date,
        time: when.date ? when.time : null,
        duration_secs:
          metadata.durationSecs === null
            ? null
            : sql`make_interval(secs => ${metadata.durationSecs})`,
      })
      .returning({ id: meetingsTable.id });
    // Only the body found above. A joint meeting's other bodies are added
    // afterwards, eg with the update_meeting tool.
    await tx
      .insert(meetingBodiesTable)
      .values({ meeting_id: meeting!.id, body_id: body.id });
    await identifyAndInsertSegments(
      tx,
      meeting!.id,
      segments,
      speakerEmbeddings,
    );
    return meeting!.id;
  });

  return {
    siteKind,
    siteId,
    status: "ingested",
    meetingId,
    segmentCount: segments.length,
    when,
  };
}

export interface IngestBatchSummary {
  results: IngestResult[];
  failures: Array<{ meeting: MeetingToIngest; error: unknown }>;
}

/**
 * Ingest a batch of meetings sequentially, continuing past individual
 * failures. Each failure is logged to stderr; the summary reports every
 * outcome so the caller can decide the exit status.
 */
export async function ingestMeetings(
  db: DB,
  meetings: Array<MeetingToIngest | string>,
  options: IngestOptions = {},
): Promise<IngestBatchSummary> {
  const results: IngestResult[] = [];
  const failures: IngestBatchSummary["failures"] = [];
  for (const meeting of meetings) {
    try {
      results.push(await ingestMeeting(db, meeting, options));
    } catch (error) {
      const m = typeof meeting === "string" ? { ref: meeting } : meeting;
      console.error(`[${m.ref}] FAILED: ${describeError(error)}`);
      failures.push({ meeting: m, error });
    }
  }
  return { results, failures };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A body that held a meeting: the one with slug `slug` if given, else the
 * one whose meeting source is the meeting's channel (a YouTube channel ID, or
 * an akleg.gov committee: see VideoMetadata.channelId).
 */
async function resolveBody(
  db: DB,
  { siteKind, siteId }: SiteMeeting,
  channelId: string,
  slug: string | undefined,
) {
  const bodies = await db
    .select({
      id: bodiesTable.id,
      name: bodiesTable.name,
      name_short: bodiesTable.name_short,
      timezone: bodiesTable.timezone,
      meeting_source: bodiesTable.meeting_source,
    })
    .from(bodiesTable);

  if (slug !== undefined) {
    const body = bodies.find((b) => bodySlug(b) === slug.toLowerCase());
    if (!body) throw new Error(`No body with slug "${slug}"`);
    const source = body.meeting_source;
    if (source && siteKindOf(source) !== siteKind)
      throw new Error(
        `${siteKind} meeting ${siteId} can't belong to ${body.name_short}, ` +
          `whose meetings are on ${siteKindOf(source)}`,
      );
    return body;
  }

  const matches = bodies.filter((b) =>
    isChannelOf(b.meeting_source, siteKind, channelId),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Error(
      `${siteKind} meeting ${siteId} is from "${channelId}", the meeting source ` +
        `of several bodies (${matches.map((b) => bodySlug(b)).join(", ")}). ` +
        `Say which body it belongs to.`,
    );
  throw new Error(
    `${siteKind} meeting ${siteId} is from "${channelId}", which is no body's ` +
      `meeting source. Refusing to ingest an unrelated meeting; if it's ` +
      `from a body's playlist, say which body it belongs to.`,
  );
}

function isChannelOf(
  source: (typeof bodiesTable.$inferSelect)["meeting_source"],
  siteKind: SiteKind,
  channelId: string,
): boolean {
  switch (source?.type) {
    case "youtube_channel":
      return siteKind === "youtube" && source.channel_id === channelId;
    case "akleg_committee":
      return siteKind === "akleg" && source.committee === channelId;
    default:
      return false;
  }
}

/**
 * Run a pipeline stage with a JSON file cache: if `artifactPath` exists, load
 * it and skip the computation; otherwise compute and persist it.
 */
async function cachedStage<T>(
  tag: string,
  artifactPath: string,
  compute: () => Promise<T> | T,
): Promise<T> {
  const artifactName = artifactPath.split("/").at(-1)!;
  if (existsSync(artifactPath)) {
    console.error(`${tag} ${artifactName} exists, skipping stage`);
    return JSON.parse(await readFile(artifactPath, "utf8")) as T;
  }
  const result = await compute();
  await writeFile(artifactPath, JSON.stringify(result, null, 2));
  return result;
}
