import {
  bodySeeds,
  type ThumbnailBody,
} from "~/features/bodies/body-thumbnail";
import {
  type ArtworkSeeds,
  GeneratedArtwork,
  ThumbnailFrame,
} from "~/features/thumbnails/thumbnail";
import { YouTubeThumbnail } from "~/features/thumbnails/youtube-thumbnail";
import { youtubeIdOf } from "@open-minutes/core/meeting-source";

export type ThumbnailMeeting = {
  id: number;
  site_kind: string;
  site_id: string;
  /** Alphabetical, as `meetingBodiesColumns` gives them. */
  bodies: ThumbnailBody[];
};

/**
 * Seeds for a meeting's artwork: its first body's palette and label, so a
 * body's meetings look related, with a layout of its own. A joint meeting
 * takes after whichever of its bodies sorts first.
 */
export function meetingSeeds(meeting: ThumbnailMeeting): ArtworkSeeds {
  const body = meeting.bodies[0];
  const layout = `meeting:${meeting.id}`;
  if (!body) return { palette: layout, layout, label: "" };
  return { ...bodySeeds(body), layout };
}

/**
 * A meeting's picture in a list: its video's thumbnail, or generated artwork
 * when it has no video or the thumbnail can't be shown.
 */
export function MeetingThumbnail(props: {
  meeting: ThumbnailMeeting;
  class?: string;
}) {
  return (
    <ThumbnailFrame class={props.class}>
      <YouTubeThumbnail
        videoId={youtubeIdOf(props.meeting)}
        fallback={<GeneratedArtwork seeds={meetingSeeds(props.meeting)} />}
      />
    </ThumbnailFrame>
  );
}
