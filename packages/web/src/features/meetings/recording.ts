/**
 * A meeting's recording, as a `with` on a meetings query: where it was
 * published, for its player, thumbnail and link.
 */
export const meetingRecordingColumns = {
  columns: { site: true, external_id: true, permalink: true },
} as const;

/** What a page needs of a meeting's recording to show its video. */
export type MeetingRecording = { site: string; external_id: string };
