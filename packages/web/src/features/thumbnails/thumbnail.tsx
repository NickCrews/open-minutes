import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { cx } from "~/lib/cva";
import { YOUTUBE_PLACEHOLDER_WIDTH, youtubeThumbnailUrl } from "~/lib/youtube";
import { ARTWORK_HEIGHT, ARTWORK_WIDTH, artwork } from "./artwork";

/** What a generated thumbnail is drawn from; see `artwork`. */
export interface ArtworkSeeds {
  palette: string;
  layout: string;
  label?: string;
}

/**
 * A 16:9 picture that gives a meeting or body something to recognize at a
 * glance in a list: its YouTube thumbnail when it has a video, and generated
 * artwork otherwise, or when the thumbnail fails to load. Decorative, since
 * a title always sits beside it.
 */
export function Thumbnail(props: {
  youtubeId?: string | null;
  seeds: ArtworkSeeds;
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
    <div
      aria-hidden="true"
      class={cx(
        "bg-muted relative aspect-video shrink-0 overflow-hidden rounded-md",
        props.class,
      )}
    >
      <Show
        when={props.youtubeId && !failed() ? props.youtubeId : undefined}
        fallback={<GeneratedArtwork seeds={props.seeds} />}
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
    </div>
  );
}

/** Seeded artwork filling its container; see `artwork`. */
export function GeneratedArtwork(props: { seeds: ArtworkSeeds }) {
  const art = () => artwork(props.seeds);
  // Gradient ids are document-global, so each picture needs its own.
  const gradient = `artwork-${createUniqueId()}`;
  return (
    <svg
      viewBox={`0 0 ${ARTWORK_WIDTH} ${ARTWORK_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      class="size-full"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color={art().from} />
          <stop offset="1" stop-color={art().to} />
        </linearGradient>
      </defs>
      <rect
        width={ARTWORK_WIDTH}
        height={ARTWORK_HEIGHT}
        fill={`url(#${gradient})`}
      />
      <For each={art().shapes}>
        {(shape) => (
          <circle
            cx={shape.cx}
            cy={shape.cy}
            r={shape.r}
            fill={shape.fill}
            fill-opacity={shape.opacity}
          />
        )}
      </For>
      <Show when={art().label}>
        {(label) => (
          <text
            x={ARTWORK_WIDTH / 2}
            y={ARTWORK_HEIGHT / 2}
            text-anchor="middle"
            dominant-baseline="central"
            fill="white"
            fill-opacity="0.92"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-weight="700"
            font-size={label().length > 5 ? "40" : "56"}
            letter-spacing="2"
          >
            {label()}
          </text>
        )}
      </Show>
    </svg>
  );
}

/** Seeds for a body's artwork: its own palette and layout, its short name. */
export function bodySeeds(body: {
  id: number;
  name: string;
  name_short: string;
}): ArtworkSeeds {
  const key = `body:${body.id}`;
  return { palette: key, layout: key, label: body.name_short || body.name };
}

/**
 * Seeds for a meeting's artwork: its body's palette and label, so a body's
 * meetings look related, with a layout of its own.
 */
export function meetingSeeds(meeting: {
  id: number;
  body: { id: number; name: string; name_short: string };
}): ArtworkSeeds {
  return { ...bodySeeds(meeting.body), layout: `meeting:${meeting.id}` };
}
