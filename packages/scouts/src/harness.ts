import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  recordingBodiesTable,
  recordingsTable,
} from "@open-minutes/db";
import type { BlobStore } from "@open-minutes/blobstore";
import type {
  FetchAudio,
  RecordingKey,
  Scout,
  ScoutedRecording,
} from "@open-minutes/core/scout";
import { SITES, type Site } from "@open-minutes/core/site";
import { firedInPastHour } from "./cron";
import type { RunLogger } from "./logger";

/** Failed audio fetches after which a recording is given up on. */
export const MAX_AUDIO_FAILURES = 3;

/**
 * How far the stored audio's duration may be from the site's `duration_secs`
 * before the fetch counts as failed.
 */
export const DURATION_TOLERANCE_SECS = 5;

/** The scouts whose cron fell in the hour up to `now`. */
export function dueScouts(scouts: readonly Scout[], now: Date): Scout[] {
  return scouts.filter((s) => firedInPastHour(s.schedule, now));
}

/** The recordings among `keys` that no scout has reported, in their order. */
export async function unseen(
  db: DB,
  keys: readonly RecordingKey[],
): Promise<RecordingKey[]> {
  const seen = new Set<string>();
  const id = (k: RecordingKey) => `${k.site}\u0000${k.external_id}`;
  const CHUNK = 1000;
  for (const site of SITES) {
    const ids = keys.filter((k) => k.site === site).map((k) => k.external_id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await db
        .select({ external_id: recordingsTable.external_id })
        .from(recordingsTable)
        .where(
          and(
            eq(recordingsTable.site, site),
            inArray(recordingsTable.external_id, ids.slice(i, i + CHUNK)),
          ),
        );
      for (const r of rows) seen.add(id({ site, external_id: r.external_id }));
    }
  }
  return keys.filter((k) => !seen.has(id(k)));
}

export interface ScanOptions {
  db: DB;
  scouts: readonly Scout[];
  logger: RunLogger;
  now?: Date;
  signal?: AbortSignal;
  /** Logs what each scout reports instead of writing it. */
  dryRun?: boolean;
}

export interface ScanResult {
  scout: string;
  /** Reports written (or, in a dry run, that would have been). */
  reported: number;
  /** Reports refused, eg for naming a body the scout may not report. */
  rejected: number;
  /** Whether the scout threw. What it yielded before then is kept. */
  failed: boolean;
}

/**
 * Runs each scout, writing each report to `recordings` and
 * `recording_bodies` as it is yielded.
 */
export async function scan({
  db,
  scouts,
  logger,
  now = new Date(),
  signal = new AbortController().signal,
  dryRun = false,
}: ScanOptions): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const scout of scouts) {
    const log = logger.child(scout.id);
    const result: ScanResult = {
      scout: scout.id,
      reported: 0,
      rejected: 0,
      failed: false,
    };
    results.push(result);
    const bodyIds = new Map(
      (
        await db
          .select({ id: bodiesTable.id, slug: bodiesTable.slug })
          .from(bodiesTable)
          .where(inArray(bodiesTable.slug, [...scout.bodies]))
      ).map((b) => [b.slug, b.id]),
    );
    try {
      for await (const report of scout.scan({
        unseen: (keys) => unseen(db, keys),
        logger: log,
        signal,
        now,
      })) {
        const problem = reportProblem(scout, report, bodyIds);
        if (problem) {
          result.rejected++;
          log.error(
            `rejected ${report.site} ${report.external_id}: ${problem}`,
          );
          continue;
        }
        if (dryRun) {
          log.info(`would report ${JSON.stringify(report)}`);
          result.reported++;
          continue;
        }
        if (await writeReport(db, scout.id, report, bodyIds)) {
          result.reported++;
        }
      }
    } catch (error) {
      result.failed = true;
      log.error("failed:", error);
    }
    log.info(
      `${dryRun ? "would have reported" : "reported"} ${result.reported} recording(s)` +
        (result.rejected ? `, rejected ${result.rejected}` : ""),
    );
  }
  return results;
}

/** Why `report` can't be written, or undefined if it can. */
function reportProblem(
  scout: Scout,
  report: ScoutedRecording,
  bodyIds: ReadonlyMap<string, number>,
): string | undefined {
  if (!(SITES as readonly string[]).includes(report.site)) {
    return `unknown site "${report.site}"`;
  }
  for (const slug of report.bodies) {
    if (!scout.bodies.includes(slug)) {
      return `body "${slug}" is not one of the scout's (${scout.bodies.join(", ")})`;
    }
    if (!bodyIds.has(slug)) return `no body "${slug}" in the database`;
  }
  return undefined;
}

/**
 * Writes one report and its bodies in a transaction. Returns false when
 * another scout already reported the recording.
 */
async function writeReport(
  db: DB,
  scoutId: string,
  report: ScoutedRecording,
  bodyIds: ReadonlyMap<string, number>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(recordingsTable)
      .values({
        site: report.site,
        external_id: report.external_id,
        permalink: report.permalink,
        title: report.title,
        description: report.description,
        published_at: report.published_at,
        // Postgres reads a bare number as seconds.
        duration_secs:
          report.duration_secs == null ? null : `${report.duration_secs}`,
        scout_id: scoutId,
        is_meeting: report.is_meeting,
        notes: report.notes,
      })
      .onConflictDoNothing({
        target: [recordingsTable.site, recordingsTable.external_id],
      })
      .returning({ id: recordingsTable.id });
    if (!row) return false;
    const bodies = [...new Set(report.bodies)];
    if (bodies.length) {
      await tx.insert(recordingBodiesTable).values(
        bodies.map((slug) => ({
          recording_id: row.id,
          body_id: bodyIds.get(slug)!,
        })),
      );
    }
    return true;
  });
}

/** What the audio step needs from the outside world; tests pass fakes. */
export interface AudioTools {
  /** Each site's {@link FetchAudio}. */
  fetchAudio: Record<Site, FetchAudio>;
  /** Encodes `input` for speech, to Opus in WebM at `output`. */
  encode(input: string, output: string): Promise<void>;
  /** An audio file's duration, in seconds. */
  duration(file: string): Promise<number>;
  /** Uploads `file` to the blob store at `key`. */
  upload(file: string, key: string): Promise<void>;
  store: BlobStore;
}

export interface StoreAudioOptions {
  db: DB;
  tools: AudioTools;
  logger: RunLogger;
  /** The most recordings to fetch in this run. */
  cap: number;
  signal?: AbortSignal;
  /** Logs which recordings it would fetch instead of fetching them. */
  dryRun?: boolean;
}

export interface StoreAudioResult {
  stored: number;
  failed: number;
}

/** Whether a recording still wants its audio fetched. */
const wantsAudio = and(
  or(isNull(recordingsTable.is_meeting), ne(recordingsTable.is_meeting, false)),
  isNull(recordingsTable.audio_stored_at),
  lt(recordingsTable.audio_failures, MAX_AUDIO_FAILURES),
);

/**
 * Fetches, encodes and uploads the audio of up to `cap` recordings that want
 * it, newest `published_at` first (unknown last), and records each outcome
 * on its row.
 */
export async function storeAudio({
  db,
  tools,
  logger,
  cap,
  signal = new AbortController().signal,
  dryRun = false,
}: StoreAudioOptions): Promise<StoreAudioResult> {
  const log = logger.child("audio");
  const recordings = await db
    .select({
      id: recordingsTable.id,
      site: recordingsTable.site,
      external_id: recordingsTable.external_id,
      duration_secs: sql<
        number | null
      >`extract(epoch from ${recordingsTable.duration_secs})::float8`,
    })
    .from(recordingsTable)
    .where(wantsAudio)
    .orderBy(
      sql`${recordingsTable.published_at} DESC NULLS LAST`,
      recordingsTable.id,
    )
    .limit(cap);

  const result: StoreAudioResult = { stored: 0, failed: 0 };
  for (const r of recordings) {
    if (signal.aborted) break;
    const name = `${r.site} ${r.external_id}`;
    if (dryRun) {
      log.info(`would fetch ${name}`);
      continue;
    }
    const dir = await mkdtemp(join(tmpdir(), "scout-audio-"));
    try {
      const original = join(dir, "original");
      const speech = join(dir, "speech.webm");
      await tools.fetchAudio[r.site](r.external_id, original, signal);
      await tools.encode(original, speech);
      const secs = await tools.duration(speech);
      if (
        r.duration_secs != null &&
        Math.abs(secs - r.duration_secs) > DURATION_TOLERANCE_SECS
      ) {
        throw new Error(
          `encoded audio is ${secs.toFixed(1)} s, but the site says ${r.duration_secs} s`,
        );
      }
      const key = tools.store.recording(r).speechWebm.key;
      await tools.upload(speech, key);
      await db
        .update(recordingsTable)
        .set({ audio_stored_at: new Date(), audio_error: null })
        .where(eq(recordingsTable.id, r.id));
      result.stored++;
      log.info(`stored ${name} at ${key}`);
    } catch (error) {
      result.failed++;
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(recordingsTable)
        .set({
          audio_failures: sql`${recordingsTable.audio_failures} + 1`,
          audio_error: message,
        })
        .where(eq(recordingsTable.id, r.id));
      log.error(`fetching ${name} failed:`, error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return result;
}

/**
 * Recordings ready to become meetings: not ruled out, audio stored, and no
 * meeting points at them.
 */
export function availableRecordings(db: DB) {
  return db
    .select({
      id: recordingsTable.id,
      site: recordingsTable.site,
      external_id: recordingsTable.external_id,
      title: recordingsTable.title,
      is_meeting: recordingsTable.is_meeting,
      published_at: recordingsTable.published_at,
    })
    .from(recordingsTable)
    .leftJoin(meetingsTable, eq(meetingsTable.recording_id, recordingsTable.id))
    .where(
      and(
        or(
          isNull(recordingsTable.is_meeting),
          ne(recordingsTable.is_meeting, false),
        ),
        sql`${recordingsTable.audio_stored_at} IS NOT NULL`,
        isNull(meetingsTable.id),
      ),
    )
    .orderBy(
      sql`${recordingsTable.published_at} DESC NULLS LAST`,
      recordingsTable.id,
    );
}

/** Recordings whose audio has been given up on, with the last error. */
export function failedRecordings(db: DB) {
  return db
    .select({
      id: recordingsTable.id,
      site: recordingsTable.site,
      external_id: recordingsTable.external_id,
      audio_failures: recordingsTable.audio_failures,
      audio_error: recordingsTable.audio_error,
    })
    .from(recordingsTable)
    .where(
      and(
        isNull(recordingsTable.audio_stored_at),
        sql`${recordingsTable.audio_failures} >= ${MAX_AUDIO_FAILURES}`,
      ),
    )
    .orderBy(recordingsTable.id);
}
