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
import { YOUTUBE_PLACEHOLDER_WIDTH, youtubeThumbnailUrl } from "~/lib/youtube";

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
    if (img.naturalWidth <= YOUTUBE_PLACEHOLDER_WIDTH) setFailed(true);
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
