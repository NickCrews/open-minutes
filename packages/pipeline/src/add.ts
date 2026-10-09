import { and, eq, sql } from "drizzle-orm";
import {
  bodiesTable,
  meetingBodiesTable,
  meetingsTable,
} from "@open-minutes/db";
import type { AudioProvider } from "@open-minutes/core/audio-provider";
import { bodySlug } from "@open-minutes/core/bodies";
import { parseDateFromTitle } from "@open-minutes/core/meeting-date";
import type { SiteMeeting } from "./sites";
import type { Db } from "./db";
import { PipelineError } from "./work-dir";

export interface AddedMeeting extends SiteMeeting {
  meetingId: number;
  title: string;
  /** Slugs of the bodies that held it, as given. */
  bodies: string[];
  timezone: string;
  /** Read from the title, or null. */
  date: string | null;
  time: string | null;
}

/**
 * Add a meeting from its site to the database, untranscribed: its title,
 * description and duration from the site, its date and time as the title
 * states them, and the bodies that held it, by slug. Its timezone is the
 * first body's.
 */
export async function addMeeting(
  db: Db,
  site: AudioProvider,
  { siteKind, siteId }: SiteMeeting,
  bodySlugs: readonly string[],
): Promise<AddedMeeting> {
  if (bodySlugs.length === 0)
    throw new PipelineError("A meeting needs at least one body");
  const allBodies = await db
    .select({
      id: bodiesTable.id,
      name_short: bodiesTable.name_short,
      timezone: bodiesTable.timezone,
    })
    .from(bodiesTable);
  const bodies = [...new Set(bodySlugs.map((s) => s.toLowerCase()))].map(
    (slug) => {
      const body = allBodies.find((b) => bodySlug(b) === slug);
      if (!body)
        throw new PipelineError(
          `No body with slug "${slug}"; bodies are ${allBodies.map(bodySlug).join(", ")}`,
        );
      return body;
    },
  );

  const [existing] = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(
      and(
        eq(meetingsTable.site_kind, siteKind),
        eq(meetingsTable.site_id, siteId),
      ),
    );
  if (existing)
    throw new PipelineError(
      `${siteKind} meeting ${siteId} is already meeting ${existing.id}`,
    );

  const metadata = await site.getMetadata(siteId);
  const when = parseDateFromTitle(metadata.title, {
    uploadDate: metadata.uploadDate ?? undefined,
  });
  const timezone = bodies[0]!.timezone;

  const meetingId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(meetingsTable)
      .values({
        site_kind: siteKind,
        site_id: siteId,
        title: metadata.title,
        description: metadata.description,
        timezone,
        date: when?.date ?? null,
        time: when?.time ?? null,
        duration_secs:
          metadata.durationSecs === null
            ? null
            : sql`make_interval(secs => ${metadata.durationSecs})`,
      })
      .returning({ id: meetingsTable.id });
    await tx
      .insert(meetingBodiesTable)
      .values(bodies.map((b) => ({ meeting_id: row!.id, body_id: b.id })));
    return row!.id;
  });

  return {
    siteKind,
    siteId,
    meetingId,
    title: metadata.title,
    bodies: bodies.map(bodySlug),
    timezone,
    date: when?.date ?? null,
    time: when?.time ?? null,
  };
}
