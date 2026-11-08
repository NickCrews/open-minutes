import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  recordingBodiesTable,
  recordingsTable,
} from "@open-minutes/db";
import { type MeetingSource, siteOf } from "@open-minutes/core/meeting-source";
import type {
  RecordingLister,
  RecordingMetadata,
  Site,
  SiteAdapter,
} from "@open-minutes/core/site";
import type { BlobStore, BlobStoreWriter } from "@open-minutes/blobstore";
import { storedSite } from "@open-minutes/meeting-audio";

/** Failed attempts to store a recording's audio before scouting gives up. */
export const MAX_AUDIO_FAILURES = 3;

/** Recordings whose audio one run stores, unless `maxAudio` says otherwise. */
export const DEFAULT_MAX_AUDIO = 20;

/** Where scouting reports progress and errors: `console`, or a stand-in. */
export type ScoutLog = Pick<Console, "info" | "warn" | "error">;

export interface ScoutOptions {
  db: DB;
  /** The adapter that reaches each site itself (see `siteAdapters`). */
  sites: Record<Site, SiteAdapter>;
  /** The lister for a meeting source (see `listerFor`). */
  listerFor: (source: MeetingSource) => RecordingLister;
  /** Where recordings' metadata and audio are read from and stored. */
  store: BlobStore;
  /** Writes to `store`. Required unless `dryRun`. */
  writer: BlobStoreWriter | null;
  /** Scan only this body's meeting source, by slug. */
  body?: string;
  /**
   * Report what the run would do. New recordings' metadata is fetched from
   * their sites, but nothing is written to the database or the blob store.
   */
  dryRun?: boolean;
  /** At most this many recordings' audio is stored; default 20. */
  maxAudio?: number;
  log?: ScoutLog;
}

/** A recording, by its site and its ID there. */
export interface RecordingKey {
  site: Site;
  external_id: string;
}

/** What a run did, or with `dryRun`, would do. */
export interface ScoutReport {
  /** New recordings, with their titles. */
  found: (RecordingKey & { title: string })[];
  /** Bodies added to `recording_bodies`, by slug. */
  bodiesAdded: (RecordingKey & { body: string })[];
  /** Recordings whose audio was stored. */
  audioStored: RecordingKey[];
  /** Errors logged: with a source, a recording, or its audio. */
  errors: number;
  /** 1 if there were any errors, else 0. */
  exitCode: 0 | 1;
}

/** A recording that may need its audio stored. */
interface AudioCandidate extends RecordingKey {
  id: number | null;
  published_at: Date | null;
}

/**
 * Scans the meeting source of every body that has one (or only `body`'s),
 * stores new recordings' metadata in the blob store and the database, adds
 * the source's body to each listed recording's `recording_bodies`, then
 * stores audio for up to `maxAudio` recordings. A failure with one source or
 * recording is logged and counted, and the run goes on. See
 * docs/contributing/recordings.md.
 */
export async function scout({
  db,
  sites,
  listerFor,
  store,
  writer,
  body,
  dryRun = false,
  maxAudio = DEFAULT_MAX_AUDIO,
  log = console,
}: ScoutOptions): Promise<ScoutReport> {
  if (!dryRun && !writer) {
    throw new Error(
      "Scouting stores what it finds in the blob store, so it needs the blob store's keys (BLOB_STORE_ENDPOINT, BLOB_STORE_BUCKET, BLOB_STORE_ACCESS_KEY_ID, BLOB_STORE_SECRET_ACCESS_KEY), or --dry-run.",
    );
  }
  const stored = {
    youtube: storedSite(sites.youtube, {
      store,
      writer: dryRun ? null : writer,
    }),
    akleg: storedSite(sites.akleg, { store, writer: dryRun ? null : writer }),
  } satisfies Record<Site, SiteAdapter>;
  const report: ScoutReport = {
    found: [],
    bodiesAdded: [],
    audioStored: [],
    errors: 0,
    exitCode: 0,
  };
  const error = (message: string) => {
    log.error(message);
    report.errors++;
  };
  // New recordings a dry run found, which would be audio candidates.
  const unsaved: AudioCandidate[] = [];

  for (const source of await sourcesToScan(db, body)) {
    try {
      const found = await scanSource(db, source, {
        adapter: stored[siteOf(source.meeting_source)],
        lister: listerFor(source.meeting_source),
        dryRun,
        log,
        error,
      });
      report.found.push(...found.found);
      report.bodiesAdded.push(...found.bodiesAdded);
      unsaved.push(...found.unsaved);
    } catch (e) {
      error(`${source.slug}: ${messageOf(e)}`);
    }
  }

  const candidates = await audioCandidates(db, maxAudio, unsaved);
  if (dryRun) {
    for (const c of candidates) {
      log.info(`Would store audio for ${c.site} ${c.external_id}.`);
    }
  } else {
    report.audioStored = await storeAudio(db, stored, candidates, error, log);
  }

  report.exitCode = report.errors > 0 ? 1 : 0;
  return report;
}

/** The bodies to scan, with their sources. */
async function sourcesToScan(db: DB, slug: string | undefined) {
  const bodies = await db
    .select({
      id: bodiesTable.id,
      slug: bodiesTable.slug,
      meeting_source: bodiesTable.meeting_source,
    })
    .from(bodiesTable)
    .where(slug === undefined ? undefined : eq(bodiesTable.slug, slug))
    .orderBy(asc(bodiesTable.id));
  if (slug !== undefined && bodies.length === 0) {
    throw new Error(`No body ${slug}.`);
  }
  if (slug !== undefined && !bodies[0]!.meeting_source) {
    throw new Error(`Body ${slug} has no meeting source.`);
  }
  return bodies.flatMap(({ meeting_source, ...b }) =>
    meeting_source ? [{ ...b, meeting_source }] : [],
  );
}

/** Lists one body's source and records what it lists. */
async function scanSource(
  db: DB,
  body: { id: number; slug: string; meeting_source: MeetingSource },
  {
    adapter,
    lister,
    dryRun,
    log,
    error,
  }: {
    adapter: SiteAdapter;
    lister: RecordingLister;
    dryRun: boolean;
    log: ScoutLog;
    error: (message: string) => void;
  },
) {
  const site = adapter.site;
  const listed = [
    ...new Set(
      (await lister.listRecordings()).map((r) => adapter.recordingId(r.id)),
    ),
  ];
  log.info(`${body.slug}: ${listed.length} recordings listed.`);
  const known = new Map<string, number>();
  if (listed.length) {
    const rows = await db
      .select({
        id: recordingsTable.id,
        external_id: recordingsTable.external_id,
      })
      .from(recordingsTable)
      .where(
        and(
          eq(recordingsTable.site, site),
          inArray(recordingsTable.external_id, listed),
        ),
      );
    for (const r of rows) known.set(r.external_id, r.id);
  }

  const found: ScoutReport["found"] = [];
  const unsaved: AudioCandidate[] = [];
  // Every listed recording that is (or, in a dry run, would be) in the table.
  const inTable: { id: number | null; external_id: string }[] = [
    ...known.entries(),
  ].map(([external_id, id]) => ({ id, external_id }));
  for (const external_id of listed) {
    if (known.has(external_id)) continue;
    let metadata: RecordingMetadata;
    try {
      metadata = await adapter.getMetadata(external_id);
    } catch (e) {
      error(`${body.slug}: ${site} ${external_id}: ${messageOf(e)}`);
      continue;
    }
    if (metadata.durationSecs === null) {
      log.info(
        `${body.slug}: skipping ${site} ${external_id}, which has no complete audio yet.`,
      );
      continue;
    }
    found.push({ site, external_id, title: metadata.title });
    log.info(`${body.slug}: found ${site} ${external_id}: ${metadata.title}`);
    if (dryRun) {
      inTable.push({ id: null, external_id });
      unsaved.push({
        id: null,
        site,
        external_id,
        published_at: metadata.publishedAt,
      });
      continue;
    }
    const id = await insertRecording(db, site, external_id, metadata);
    inTable.push({ id, external_id });
  }

  const bodiesAdded: ScoutReport["bodiesAdded"] = [];
  if (dryRun) {
    const ids = inTable.flatMap((r) => (r.id === null ? [] : [r.id]));
    const has = new Set(
      ids.length
        ? (
            await db
              .select({ id: recordingBodiesTable.recording_id })
              .from(recordingBodiesTable)
              .where(
                and(
                  eq(recordingBodiesTable.body_id, body.id),
                  inArray(recordingBodiesTable.recording_id, ids),
                ),
              )
          ).map((r) => r.id)
        : [],
    );
    for (const r of inTable) {
      if (r.id === null || !has.has(r.id)) {
        bodiesAdded.push({ site, external_id: r.external_id, body: body.slug });
      }
    }
  } else if (inTable.length) {
    const added = await db
      .insert(recordingBodiesTable)
      .values(inTable.map((r) => ({ recording_id: r.id!, body_id: body.id })))
      .onConflictDoNothing()
      .returning({ id: recordingBodiesTable.recording_id });
    const externalIdOf = new Map(inTable.map((r) => [r.id, r.external_id]));
    for (const { id } of added) {
      bodiesAdded.push({
        site,
        external_id: externalIdOf.get(id)!,
        body: body.slug,
      });
    }
  }
  if (bodiesAdded.length) {
    log.info(
      `${body.slug}: ${dryRun ? "would add" : "added"} the body to ${bodiesAdded.length} recordings.`,
    );
  }
  return { found, bodiesAdded, unsaved };
}

/** Inserts a found recording's row, and returns its id. */
async function insertRecording(
  db: DB,
  site: Site,
  external_id: string,
  metadata: RecordingMetadata,
): Promise<number> {
  const [row] = await db
    .insert(recordingsTable)
    .values({
      site,
      external_id,
      permalink: metadata.permalink,
      title: metadata.title,
      description: metadata.description,
      published_at: metadata.publishedAt,
      // Postgres reads a bare number as seconds.
      duration_secs: `${metadata.durationSecs}`,
    })
    .returning({ id: recordingsTable.id });
  return row!.id;
}

/**
 * Up to `limit` recordings that may be meetings and need their audio
 * stored, newest first, unknown publish times last. `unsaved` are
 * recordings a dry run found, which a run would have inserted.
 */
async function audioCandidates(
  db: DB,
  limit: number,
  unsaved: AudioCandidate[],
): Promise<AudioCandidate[]> {
  const rows = await db
    .select({
      id: recordingsTable.id,
      site: recordingsTable.site,
      external_id: recordingsTable.external_id,
      published_at: recordingsTable.published_at,
    })
    .from(recordingsTable)
    .where(
      and(
        or(
          isNull(recordingsTable.is_meeting),
          eq(recordingsTable.is_meeting, true),
        ),
        isNull(recordingsTable.audio_stored_at),
        sql`cardinality(${recordingsTable.audio_error_history}) < ${MAX_AUDIO_FAILURES}`,
      ),
    )
    .orderBy(
      sql`${recordingsTable.published_at} DESC NULLS LAST`,
      asc(recordingsTable.id),
    )
    .limit(limit);
  if (!unsaved.length) return rows;
  const newestFirst = (a: AudioCandidate, b: AudioCandidate) =>
    (b.published_at?.getTime() ?? -Infinity) -
    (a.published_at?.getTime() ?? -Infinity);
  return [...rows, ...unsaved].sort(newestFirst).slice(0, limit);
}

/**
 * Stores each candidate's audio through `stored`, and records on its row
 * that it was stored, or why it wasn't.
 */
async function storeAudio(
  db: DB,
  stored: Record<Site, SiteAdapter>,
  candidates: AudioCandidate[],
  error: (message: string) => void,
  log: ScoutLog,
): Promise<RecordingKey[]> {
  const done: RecordingKey[] = [];
  if (!candidates.length) return done;
  const dir = await mkdtemp(join(tmpdir(), "scout-audio-"));
  try {
    for (const [i, c] of candidates.entries()) {
      const id = c.id!;
      const path = join(dir, `${i}.webm`);
      try {
        await stored[c.site].downloadAudio(c.external_id, path);
        await db
          .update(recordingsTable)
          .set({ audio_stored_at: new Date() })
          .where(eq(recordingsTable.id, id));
        done.push({ site: c.site, external_id: c.external_id });
        log.info(`Stored audio for ${c.site} ${c.external_id}.`);
      } catch (e) {
        const message = messageOf(e);
        await db
          .update(recordingsTable)
          .set({
            audio_error_history: sql`array_append(${recordingsTable.audio_error_history}, ${message}::varchar)`,
          })
          .where(eq(recordingsTable.id, id));
        error(`${c.site} ${c.external_id}: storing audio: ${message}`);
      } finally {
        await rm(path, { force: true });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return done;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
