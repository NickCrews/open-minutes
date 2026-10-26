import {
  type AkLeg,
  type AkLegMeeting,
  akleg,
  legislatureOf,
  mainAudio,
  meetingUrl,
  toMetadata,
} from "@open-minutes/akleg";
import type {
  Scout,
  ScoutContext,
  ScoutedRecording,
} from "@open-minutes/core/scout";

export interface AklegScoutOptions {
  id: string;
  name: string;
  /** Each body's committee, by body slug: { hres: "HRES" }. */
  committees: Readonly<Record<string, string>>;
  schedule: string;
  /** Replaces the real akleg.gov client; tests pass a fake. */
  client?: AkLeg;
}

/**
 * A meeting is reported once a day has passed since its scheduled start, so
 * a meeting still being recorded isn't reported with part of its audio.
 */
const WAIT_MS = 24 * 60 * 60 * 1000;

/** What the akleg.gov scout reports for a committee's meeting. */
export function scoutedFromMeeting(
  meeting: AkLegMeeting,
  body: string,
): ScoutedRecording {
  const metadata = toMetadata(meeting);
  return {
    site: "akleg",
    external_id: meeting.id,
    permalink: meetingUrl(meeting.id),
    title: metadata.title,
    description: metadata.description,
    // akleg.gov doesn't say when it published a recording.
    published_at: null,
    duration_secs: mainAudio(meeting)?.durationSecs ?? null,
    is_meeting: true,
    notes: "",
    bodies: [body],
  };
}

/**
 * A scout of akleg.gov committees, in the Legislature sitting at the run's
 * `now`. Each committee's recordings are its body's meetings.
 */
export function aklegScout(opts: AklegScoutOptions): Scout {
  return {
    id: opts.id,
    name: opts.name,
    bodies: Object.keys(opts.committees),
    schedule: opts.schedule,
    async *scan(ctx: ScoutContext) {
      const client = opts.client ?? akleg();
      const legislature = legislatureOf(ctx.now.getUTCFullYear());
      // Scheduled starts are Alaska time, behind UTC, so this is a little
      // over a day in.
      const cutoff = new Date(ctx.now.getTime() - WAIT_MS)
        .toISOString()
        .slice(0, 10);
      for (const [body, committee] of Object.entries(opts.committees)) {
        ctx.signal.throwIfAborted();
        let meetings: AkLegMeeting[];
        try {
          meetings = await client.meetingsOfCommittee(committee, legislature);
        } catch (error) {
          ctx.logger.error(
            `listing ${committee} in Legislature ${legislature}:`,
            error,
          );
          continue;
        }
        const done = meetings.filter((m) => !m.cancelled && m.date < cutoff);
        const todo = new Set(
          (
            await ctx.unseen(
              done.map((m) => ({ site: "akleg" as const, external_id: m.id })),
            )
          ).map((k) => k.external_id),
        );
        ctx.logger.info(
          `${committee}: ${meetings.length} meetings with audio, ${todo.size} unseen`,
        );
        for (const meeting of done) {
          if (todo.has(meeting.id)) yield scoutedFromMeeting(meeting, body);
        }
      }
    },
  };
}
