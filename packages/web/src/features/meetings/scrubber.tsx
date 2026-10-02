import { createMemo, createSignal, For, Show } from "solid-js";
import { formatTimestamp } from "~/lib/format";
import {
  type Chapter,
  chapterIndexAt,
  type ScrubberPart,
  scrubberParts,
} from "./chapters";

/** How far the arrow keys move the playhead, in seconds. */
const STEP_SECS = 5;
/**
 * PageUp within this many seconds of a chapter's start goes to the previous
 * chapter rather than back to the start of this one, as a music player's "back"
 * does.
 */
const RESTART_GRACE_SECS = 3;

/**
 * A playback bar split into one piece per chapter, with uncovered time drawn
 * hatched so the eye lands on chapters. Hovering names the chapter under the
 * pointer; clicking seeks to the exact spot, and dragging scrubs. With no
 * chapters it is a plain scrubber.
 */
export function Scrubber(props: {
  chapters: Chapter[];
  /** Video length in seconds; nothing draws until it's known. */
  duration: () => number;
  currentTime: () => number;
  /** `final` is false while dragging and true on release. */
  onSeek: (secs: number, final: boolean) => void;
}) {
  let bar!: HTMLDivElement;
  const parts = createMemo(() =>
    scrubberParts(props.chapters, props.duration()),
  );
  const [hover, setHover] = createSignal<{ secs: number; x: number }>();
  const [dragging, setDragging] = createSignal(false);

  const fraction = (secs: number) =>
    props.duration() > 0
      ? Math.min(1, Math.max(0, secs / props.duration()))
      : 0;
  const pct = (secs: number) => `${fraction(secs) * 100}%`;
  const secsAt = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { secs: f * props.duration(), x: clientX - r.left };
  };

  const chapterAt = (secs: number) => {
    const i = chapterIndexAt(props.chapters, secs);
    return i === -1 ? undefined : props.chapters[i];
  };
  const hovered = createMemo(() => {
    const h = hover();
    return h && { ...h, chapter: chapterAt(h.secs) };
  });

  const seekKey = (e: KeyboardEvent) => {
    const t = props.currentTime();
    const starts = props.chapters.map((c) => c.start);
    let target: number | undefined;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        target = t - STEP_SECS;
        break;
      case "ArrowRight":
      case "ArrowUp":
        target = t + STEP_SECS;
        break;
      case "PageUp":
        target =
          starts.filter((s) => s < t - RESTART_GRACE_SECS).at(-1) ??
          (starts.length ? 0 : t - STEP_SECS * 6);
        break;
      case "PageDown":
        target =
          starts.find((s) => s > t + 0.5) ??
          (starts.length ? undefined : t + STEP_SECS * 6);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = props.duration();
        break;
      default:
        return;
    }
    e.preventDefault();
    if (target === undefined) return;
    props.onSeek(Math.min(props.duration(), Math.max(0, target)), true);
  };

  const valueText = () => {
    const t = props.currentTime();
    const chapter = chapterAt(t);
    return chapter
      ? `${formatTimestamp(t)}, in chapter: ${chapter.title}`
      : formatTimestamp(t);
  };

  return (
    <Show when={props.duration() > 0}>
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(props.duration())}
        aria-valuenow={Math.round(props.currentTime())}
        aria-valuetext={valueText()}
        class="group focus-visible:ring-ring/50 relative h-5 shrink-0 cursor-pointer touch-none rounded-sm outline-none select-none focus-visible:ring-[3px]"
        onKeyDown={seekKey}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          bar.setPointerCapture(e.pointerId);
          setDragging(true);
          props.onSeek(secsAt(e.clientX).secs, false);
        }}
        onPointerMove={(e) => {
          const at = secsAt(e.clientX);
          setHover(at);
          if (dragging()) props.onSeek(at.secs, false);
        }}
        onPointerUp={(e) => {
          if (!dragging()) return;
          setDragging(false);
          props.onSeek(secsAt(e.clientX).secs, true);
        }}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={() => !dragging() && setHover(undefined)}
      >
        <div class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 transition-[height] group-hover:h-2.5">
          <For each={parts()}>
            {(part) => (
              <Piece
                part={part}
                left={pct(part.start)}
                width={`${(fraction(part.end) - fraction(part.start)) * 100}%`}
                played={Math.min(
                  1,
                  Math.max(
                    0,
                    (props.currentTime() - part.start) /
                      (part.end - part.start),
                  ),
                )}
                gapped={props.chapters.length > 0}
              />
            )}
          </For>
        </div>
        <div
          aria-hidden="true"
          class="bg-primary pointer-events-none absolute top-1/2 size-3 -translate-1/2 rounded-full shadow transition-transform group-hover:scale-125"
          style={{ left: pct(props.currentTime()) }}
        />
        {/* Above the bar, never over it, so the thumb stays visible. */}
        <Show when={hovered()}>
          {(h) => (
            <div
              class="bg-popover text-popover-foreground pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-64 -translate-x-1/2 rounded-md border px-2 py-1 text-xs shadow-md"
              style={{
                left: `clamp(8rem, ${h().x}px, calc(100% - 8rem))`,
              }}
            >
              <Show when={h().chapter}>
                {(c) => <p class="truncate font-medium">{c().title}</p>}
              </Show>
              <p class="text-muted-foreground tabular-nums">
                {formatTimestamp(h().secs)}
                <Show when={h().chapter}>
                  {(c) => (
                    <>
                      {" "}
                      · {formatTimestamp(c().start)}–{formatTimestamp(c().end)}
                    </>
                  )}
                </Show>
              </p>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

/**
 * One chapter or gap. A 1px inset each side leaves a 2px gap between
 * neighbours; a piece too narrow for that keeps a 2px minimum instead, so
 * short chapters stay visible without separators eating them.
 */
function Piece(props: {
  part: ScrubberPart;
  left: string;
  width: string;
  /** How much of this piece has played, 0 to 1. */
  played: number;
  /** Whether to inset for separators; a lone plain bar has none. */
  gapped: boolean;
}) {
  const inset = () => (props.gapped ? 1 : 0);
  return (
    <div
      class="absolute inset-y-0 overflow-hidden rounded-[2px]"
      classList={{
        "bg-muted-foreground/30":
          props.part.kind === "chapter" || !props.gapped,
        "scrubber-gap": props.part.kind === "gap" && props.gapped,
      }}
      style={{
        left: `calc(${props.left} + ${inset()}px)`,
        width: `max(2px, calc(${props.width} - ${inset() * 2}px))`,
      }}
    >
      <div
        class="h-full"
        classList={{
          "bg-primary": props.part.kind === "chapter" || !props.gapped,
          "bg-primary/40": props.part.kind === "gap" && props.gapped,
        }}
        style={{ width: `${props.played * 100}%` }}
      />
    </div>
  );
}
