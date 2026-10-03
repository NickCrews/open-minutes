import { createSignal, onMount, Show } from "solid-js";
import {
  bodySeeds,
  type ThumbnailBody,
} from "~/features/bodies/body-thumbnail";
import {
  type ArtworkSeeds,
  GeneratedArtwork,
  ThumbnailFrame,
} from "~/features/thumbnails/thumbnail";
import { youtubeThumbnailUrl } from "~/lib/youtube";

/**
 * For a video that's gone or private, YouTube answers the thumbnail request
 * with a 120px-wide grey placeholder (and a 404 that browsers may still
 * render), where a real thumbnail is 320px wide. Anything this narrow counts
 * as missing.
 */
const PLACEHOLDER_MAX_WIDTH = 120;

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
 * A meeting's picture in a list: its YouTube thumbnail, or generated artwork
 * when it has no video, the image fails to load, or YouTube answers with its
 * placeholder for a removed video.
 */
export function MeetingThumbnail(props: {
  meeting: ThumbnailMeeting;
  class?: string;
}) {
  const [failed, setFailed] = createSignal(false);
  const checkLoaded = (img: HTMLImageElement) => {
    if (img.naturalWidth <= PLACEHOLDER_MAX_WIDTH) setFailed(true);
  };
  let img: HTMLImageElement | undefined;
  // A server-rendered image may have finished, or failed, before hydration
  // attached its handlers.
  onMount(() => {
    if (img?.complete) checkLoaded(img);
  });

  return (
    <ThumbnailFrame class={props.class}>
      <Show
        when={
          props.meeting.youtube_id && !failed()
            ? props.meeting.youtube_id
            : undefined
        }
        fallback={<GeneratedArtwork seeds={meetingSeeds(props.meeting)} />}
      >
        {(id) => (
          <img
            ref={img}
            src={youtubeThumbnailUrl(id())}
            alt=""
            loading="lazy"
            decoding="async"
            width={320}
            height={180}
            class="size-full object-cover"
            onLoad={(e) => checkLoaded(e.currentTarget)}
            onError={() => setFailed(true)}
          />
        )}
      </Show>
    </ThumbnailFrame>
  );
}
