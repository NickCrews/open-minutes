/**
 * A meeting's recording, as a `with` on a meetings query: where it was
 * published, for its player, thumbnail and link.
 */
export const meetingRecordingColumns = {
  columns: { site: true, external_id: true, permalink: true },
} as const;

/** What a page needs of a meeting's recording to show its video. */
export type MeetingRecording = { site: string; external_id: string };

/**
 * The recording's YouTube video ID, or null when it isn't on YouTube. For
 * what only works with YouTube: its player and thumbnails.
 */
export function youtubeIdOf(recording: MeetingRecording): string | null {
  return recording.site === "youtube" ? recording.external_id : null;
}
