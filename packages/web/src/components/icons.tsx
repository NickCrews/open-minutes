import type { JSX } from "solid-js";

type IconProps = { class?: string };

/** Shared attributes for 24×24 stroked icons drawn in the text color. */
function StrokeIcon(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class ?? "size-3.5 shrink-0"}
    >
      {props.children}
    </svg>
  );
}

/** A map pin, for a location such as a body's jurisdiction. */
export function PinIcon(props: IconProps) {
  return (
    <StrokeIcon class={props.class}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </StrokeIcon>
  );
}
