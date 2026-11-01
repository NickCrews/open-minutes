import type { JSX } from "solid-js";

/**
 * Every icon takes the same props. Icons carry no size of their own: inside a
 * Button they get the button's default svg size, and elsewhere the caller sizes
 * them with `class`, eg "size-3.5 shrink-0". They draw in the text color and
 * are hidden from screen readers, so the surrounding control supplies the label.
 */
export type IconProps = { class?: string };

/** A 24×24 icon stroked in the text color; shapes may also fill with currentColor. */
function Icon(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      {props.children}
    </svg>
  );
}

/** A map pin, for a location such as a body's jurisdiction. */
export function PinIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <polygon points="6 3 20 12 6 21" fill="currentColor" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" />
    </Icon>
  );
}

/** A circular arrow pointing back, labelled with the jump size in seconds. */
export function SkipBackIcon(props: IconProps & { seconds: number }) {
  return (
    <Icon class={props.class}>
      <path d="M3 3v6h6" />
      <path d="M3.5 14.5a9 9 0 1 0 2.1-9.4L3 9" />
      <SkipLabel seconds={props.seconds} />
    </Icon>
  );
}

/** A circular arrow pointing forward, labelled with the jump size in seconds. */
export function SkipForwardIcon(props: IconProps & { seconds: number }) {
  return (
    <Icon class={props.class}>
      <path d="M21 3v6h-6" />
      <path d="M20.5 14.5a9 9 0 1 1-2.1-9.4L21 9" />
      <SkipLabel seconds={props.seconds} />
    </Icon>
  );
}

function SkipLabel(props: { seconds: number }) {
  return (
    <text
      x="12"
      y="17"
      text-anchor="middle"
      font-size="9"
      stroke="none"
      fill="currentColor"
    >
      {props.seconds}
    </text>
  );
}

/** Crosshairs, for returning to the playhead. */
export function PlayheadIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
    </Icon>
  );
}

/** A head and shoulders, for a person. */
export function PersonIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Icon>
  );
}

/** A calendar page, for a meeting. */
export function CalendarIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Icon>
  );
}

/** A columned building, for a body such as a board or assembly. */
export function BuildingIcon(props: IconProps) {
  return (
    <Icon class={props.class}>
      <path d="M3 21h18M4 10h16M12 3 3 8v2h18V8Z" />
      <path d="M6 10v8M10 10v8M14 10v8M18 10v8M4 18h16" />
    </Icon>
  );
}
