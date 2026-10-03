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

export type ThumbnailMeeting = {
  id: number;
  youtube_id: string;
  body: ThumbnailBody;
};

/**
 * Seeds for a meeting's artwork: its body's palette and label, so a body's
 * meetings look related, with a layout of its own.
 */
export function meetingSeeds(meeting: ThumbnailMeeting): ArtworkSeeds {
  return { ...bodySeeds(meeting.body), layout: `meeting:${meeting.id}` };
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
        videoId={props.meeting.youtube_id}
        fallback={<GeneratedArtwork seeds={meetingSeeds(props.meeting)} />}
      />
    </ThumbnailFrame>
  );
}
