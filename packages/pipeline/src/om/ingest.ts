import { count, eq, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  segmentsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import { youtubeFromEnv } from "../youtube";
import { describeError } from "./runs";
import { type ProcessOptions, processMeeting } from "./process";

export type IngestOptions = Omit<ProcessOptions, "steps">;

export type IngestResult =
  | {
      youtubeId: string;
      status: "ingested";
      meetingId: number;
      segmentCount: number;
    }
  | { youtubeId: string; status: "skipped" };

/**
 * Ingest one video by hand: record it as a meeting if it isn't one yet, then
 * process it (see `processMeeting`). The scheduled path splits these: a sweep
 * discovers meetings, and each is processed in its own job.
 *
 * A video that isn't a meeting yet is attributed to a body by its channel,
 * which must be one of the bodies' video sources; anything else is refused.
 * Returns `skipped` when there was nothing due (it was already transcribed).
 *
 * @throws if the video can't be attributed, or a step fails. A failure leaves
 * the meeting recorded, with the failed run, so the sweep retries it.
 */
export async function ingestVideo(
  db: DB,
  youtubeId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const yt = options.yt ?? youtubeFromEnv();

  const [existing] = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(eq(meetingsTable.youtube_id, youtubeId));
  if (!existing) {
    console.error(`[${youtubeId}] fetching video metadata...`);
    const metadata = await yt.getMetadata(youtubeId);
    const bodyId = await resolveBody(db, youtubeId, metadata.channelId);
    await db
      .insert(meetingsTable)
      .values({
        body_id: bodyId,
        youtube_id: youtubeId,
        title: metadata.title,
        description: metadata.description,
        duration_secs:
          metadata.durationSecs === null
            ? null
            : sql`make_interval(secs => ${metadata.durationSecs})`,
      })
      .onConflictDoNothing({ target: meetingsTable.youtube_id });
  }

  // Asked for by name, so a step that failed too often is tried again.
  const result = await processMeeting(db, youtubeId, {
    retry: true,
    ...options,
    yt,
  });
  if (!result.steps.some((s) => s.outcome === "succeeded")) {
    console.error(`[${youtubeId}] nothing to do, skipping`);
    return { youtubeId, status: "skipped" };
  }
  const [segments] = await db
    .select({ n: count() })
    .from(segmentsTable)
    .where(eq(segmentsTable.meeting_id, result.meetingId));
  return {
    youtubeId,
    status: "ingested",
    meetingId: result.meetingId,
    segmentCount: segments!.n,
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

async function resolveBody(
  db: DB,
  youtubeId: string,
  channelId: string,
): Promise<number> {
  if (channelId) {
    const [body] = await db
      .select({ id: bodiesTable.id })
      .from(bodiesTable)
      .innerJoin(
        videoSourcesTable,
        eq(videoSourcesTable.body_id, bodiesTable.id),
      )
      .where(eq(videoSourcesTable.youtube_id, channelId))
      .limit(1);
    if (body) return body.id;
  }
  throw new Error(
    `Video ${youtubeId} is on channel "${channelId}", which matches no ` +
      `body's video sources. Refusing to ingest an unrelated video.`,
  );
}
