/**
 * The sites recordings are published on: `recordings.site`. A recording's ID
 * on its site (`recordings.external_id`) is a YouTube video ID, or an
 * akleg.gov meeting ID ("HRES 2018-09-10 14:00:00").
 */
export const SITES = ["youtube", "akleg"] as const;
export type Site = (typeof SITES)[number];

/** A recording's key: `recordings.site` and `recordings.external_id`. */
export interface RecordingKey {
  site: Site;
  external_id: string;
}

/**
 * The recording's YouTube video ID, or null when it isn't on YouTube. For
 * what only works with YouTube: its player and thumbnails.
 */
export function youtubeIdOf(recording: {
  site: string;
  external_id: string;
}): string | null {
  return recording.site === "youtube" ? recording.external_id : null;
}
