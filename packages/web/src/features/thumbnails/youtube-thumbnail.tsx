import { createSignal, type JSX, onMount, Show } from "solid-js";

/**
 * For a video that's gone or private, YouTube answers the thumbnail request
 * with a 120px-wide grey placeholder (and a 404 that browsers may still
 * render), where a real thumbnail is 320px wide. Anything this narrow counts
 * as missing.
 */
const PLACEHOLDER_MAX_WIDTH = 120;

/**
 * A video's 320×180 thumbnail. YouTube serves this size for every video,
 * unlike the larger ones, which only exist for HD uploads.
 */
function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

/**
 * A YouTube video's thumbnail, filling its container. Shows `fallback`
 * instead when there's no video id, the image fails to load, or YouTube
 * answers with its placeholder for a removed video.
 */
export function YouTubeThumbnail(props: {
  videoId: string | null | undefined;
  fallback: JSX.Element;
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
    <Show
      when={props.videoId && !failed() ? props.videoId : undefined}
      fallback={props.fallback}
    >
      {(id) => (
        <img
          ref={img}
          src={thumbnailUrl(id())}
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
  );
}
