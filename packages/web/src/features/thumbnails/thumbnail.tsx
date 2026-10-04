import { createUniqueId, For, type JSX, Show } from "solid-js";
import { cx } from "~/lib/cva";
import { ARTWORK_HEIGHT, ARTWORK_WIDTH, artwork } from "./artwork";

/** What a generated thumbnail is drawn from; see `artwork`. */
export interface ArtworkSeeds {
  palette: string;
  layout: string;
  label?: string;
}

/**
 * The 16:9 box every thumbnail sits in, so a list's pictures line up whatever
 * fills them. Decorative, since a title always sits beside a thumbnail.
 */
export function ThumbnailFrame(props: {
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div
      aria-hidden="true"
      class={cx(
        "bg-muted relative aspect-video shrink-0 overflow-hidden rounded-md",
        props.class,
      )}
    >
      {props.children}
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
