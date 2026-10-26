import type {
  Scout,
  ScoutContext,
  ScoutedRecording,
} from "@open-minutes/core/scout";
import {
  type YtDlpInfo,
  isComplete,
  listVideosIn,
  publishedAt,
  videoInfo,
} from "@open-minutes/youtube";
import { egress } from "@open-minutes/ytdlp";

export interface YoutubeChannelScoutOptions {
  id: string;
  name: string;
  /** "UC..." */
  channelId: string;
  bodies: readonly string[];
  schedule: string;
}

/**
 * Whether a title says the video isn't a meeting. Null when it doesn't say
 * either way, which leaves it to ingestion.
 */
export function judgeTitle(title: string): {
  is_meeting: boolean | null;
  notes: string;
} {
  if (/\btest\b/i.test(title)) {
    return { is_meeting: false, notes: '"test" in the title' };
  }
  return { is_meeting: null, notes: "" };
}

/** What a YouTube scout reports for a video, from yt-dlp's info JSON. */
export function scoutedFromInfo(info: YtDlpInfo): ScoutedRecording {
  const title = info.title ?? "";
  return {
    site: "youtube",
    external_id: info.id,
    permalink: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
    title,
    description: info.description ?? "",
    published_at: publishedAt(info),
    duration_secs: info.duration ?? null,
    ...judgeTitle(title),
    bodies: [],
  };
}

/**
 * A scout of every video on a YouTube channel. It lists the channel, then
 * reads each unseen video's metadata, skipping streams that are live or
 * upcoming; they are still unseen on the next run.
 */
export function youtubeChannelScout(opts: YoutubeChannelScoutOptions): Scout {
  return {
    id: opts.id,
    name: opts.name,
    bodies: opts.bodies,
    schedule: opts.schedule,
    async *scan(ctx: ScoutContext) {
      const listed = await listVideosIn({
        kind: "channel",
        id: opts.channelId,
      });
      const todo = await ctx.unseen(
        listed.map((v) => ({ site: "youtube" as const, external_id: v.id })),
      );
      ctx.logger.info(
        `${listed.length} videos on the channel, ${todo.length} unseen`,
      );
      // One manager for the whole scan keeps WARP and Tor up between videos.
      const routes = egress({ log: (line) => ctx.logger.info(line) });
      try {
        for (const { external_id } of todo) {
          ctx.signal.throwIfAborted();
          let info: YtDlpInfo;
          try {
            info = await videoInfo(routes, external_id);
          } catch (error) {
            ctx.logger.error(`metadata for ${external_id}:`, error);
            continue;
          }
          if (!isComplete(info)) {
            ctx.logger.info(`skipping ${external_id}: ${info.live_status}`);
            continue;
          }
          yield scoutedFromInfo(info);
        }
      } finally {
        await routes.close();
      }
    },
  };
}
