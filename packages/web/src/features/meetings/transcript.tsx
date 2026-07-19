import { Link } from "@tanstack/solid-router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "~/components/button";
import { formatTimestamp } from "~/lib/format";
import type { getMeetingById } from "./index";

type Meeting = Awaited<ReturnType<typeof getMeetingById>>;
export type Segment = Meeting["segments"][number];
type SegmentStatus = "past" | "active" | "future";

function segmentStart(segment: Segment): number {
  return segment.words[0]?.start ?? 0;
}

export function Transcript(props: {
  segments: Segment[];
  currentTime: () => number;
  onSeek: (secs: number) => void;
}) {
  let container!: HTMLDivElement;
  // Whether the transcript auto-scrolls to track playback. Manual scrolling
  // turns it off; seeking or the resume button turns it back on.
  const [following, setFollowing] = createSignal(true);

  const starts = createMemo(() => props.segments.map(segmentStart));
  // Index of the segment being spoken: the last one starting at or before the
  // playhead, -1 before the first segment starts.
  const activeIndex = createMemo(() => {
    const t = props.currentTime();
    return lastIndexAtOrBefore(starts(), t);
  });

  const seek = (secs: number) => {
    setFollowing(true);
    props.onSeek(secs);
  };

  onMount(() => {
    const stopFollowing = () => setFollowing(false);
    container.addEventListener("wheel", stopFollowing, { passive: true });
    container.addEventListener("touchmove", stopFollowing, { passive: true });
    onCleanup(() => {
      container.removeEventListener("wheel", stopFollowing);
      container.removeEventListener("touchmove", stopFollowing);
    });
  });

  // Keep the playhead word in the upper-middle band of the viewport,
  // scrolling in steps rather than continuously.
  createEffect(() => {
    if (!following()) return;
    props.currentTime();
    const word = container.querySelector<HTMLElement>("[data-playhead]");
    if (!word) return;
    const c = container.getBoundingClientRect();
    const r = word.getBoundingClientRect();
    if (r.top < c.top + c.height * 0.15 || r.bottom > c.top + c.height * 0.6) {
      container.scrollBy({
        top: r.top - (c.top + c.height * 0.3),
        behavior: "smooth",
      });
    }
  });

  return (
    <div class="relative min-h-0 flex-1">
      <div ref={container} class="h-full overflow-y-auto rounded-lg border">
        <div class="flex flex-col gap-4 p-4">
          <For
            each={props.segments}
            fallback={
              <p class="text-muted-foreground">No transcript segments yet.</p>
            }
          >
            {(segment, i) => (
              <SegmentBlock
                segment={segment}
                status={() =>
                  i() < activeIndex()
                    ? "past"
                    : i() === activeIndex()
                      ? "active"
                      : "future"
                }
                currentTime={props.currentTime}
                onSeek={seek}
              />
            )}
          </For>
        </div>
      </div>
      <Show when={!following()}>
        <Button
          variant="secondary"
          size="sm"
          class="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          onClick={() => setFollowing(true)}
        >
          Resume auto-scroll
        </Button>
      </Show>
    </div>
  );
}

function SegmentBlock(props: {
  segment: Segment;
  status: () => SegmentStatus;
  currentTime: () => number;
  onSeek: (secs: number) => void;
}) {
  const wordStarts = createMemo(() => props.segment.words.map((w) => w.start));
  // Index of the word at the playhead: -1 before this segment starts,
  // words.length once it's fully spoken. Past/future segments never read
  // currentTime, so only the active segment re-renders during playback.
  const playheadIndex = createMemo(() => {
    switch (props.status()) {
      case "past":
        return props.segment.words.length;
      case "future":
        return -1;
      case "active":
        return lastIndexAtOrBefore(wordStarts(), props.currentTime());
    }
  });

  return (
    <div>
      <div class="flex items-baseline gap-2 text-sm">
        <span class="font-semibold">
          <Show
            when={props.segment.person}
            fallback={
              props.segment.speaker_number != null
                ? `Speaker ${props.segment.speaker_number}`
                : "Unknown"
            }
          >
            {(person) => (
              <Link
                to="/people/$id"
                params={{ id: String(person().id) }}
                class="hover:underline"
              >
                {person().name || "(unnamed)"}
              </Link>
            )}
          </Show>
        </span>
        <button
          type="button"
          class="text-muted-foreground text-xs tabular-nums hover:underline"
          onClick={() => props.onSeek(segmentStart(props.segment))}
        >
          {formatTimestamp(segmentStart(props.segment))}
        </button>
      </div>
      <p class="leading-relaxed">
        <Index each={props.segment.words}>
          {(word, i) => (
            <span
              class="cursor-pointer rounded-sm transition-opacity duration-300 data-playhead:bg-primary/10"
              classList={{ "opacity-30": i > playheadIndex() }}
              data-playhead={i === playheadIndex() ? "" : undefined}
              onClick={() => props.onSeek(word().start)}
            >
              {word().text}{" "}
            </span>
          )}
        </Index>
      </p>
    </div>
  );
}

/** Index of the last value in a sorted array that is <= target, or -1. */
function lastIndexAtOrBefore(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= target) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
