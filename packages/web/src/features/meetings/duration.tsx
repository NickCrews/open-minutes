import { Show } from "solid-js";
import { formatDuration } from "~/lib/format";

/**
 * How long a meeting ran, at minute precision — a meeting is long enough that
 * seconds are noise. Collapses away when the duration is unknown: unlike a
 * start time, nobody enters this by hand, so an absent one is nothing to fix.
 *
 * Takes the interval rather than a meeting row, so the list and detail pages
 * can share it despite selecting different columns.
 */
export function Duration(props: {
  durationSecs: string | null;
  /** Rendered before the duration, but only when there is something to separate. */
  prefix?: string;
}) {
  return (
    <Show when={props.durationSecs}>
      {(secs) => (
        <>
          {props.prefix}
          {/* inline-flex, not flex: this sits in a flex row on the list page but
              mid-sentence on the detail page, where a block would break the line. */}
          <span class="inline-flex items-center gap-1">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              class="size-3.5 shrink-0"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            {formatDuration(secs(), "minutes")}
          </span>
        </>
      )}
    </Show>
  );
}
