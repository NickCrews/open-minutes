import { Link } from "@tanstack/solid-router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/tooltip";
import { formatTimestamp } from "~/lib/format";
import { PLAYBACK_RATES } from "~/lib/youtube";
import {
  assignSpeakers,
  type Segment,
  speakerColor,
  type SpeakerIdentity,
  speakerKey,
  SpeakerSwatch,
} from "./speaker-identity";

type SegmentStatus = "past" | "active" | "future";

/** A search hit, as the inclusive range of words it covers in one segment. */
type Match = { segment: number; from: number; to: number };

const MIN_QUERY_LENGTH = 2;
/** How far the skip buttons jump, in seconds. */
const JUMP_SECS = 15;

function segmentStart(segment: Segment): number {
  return segment.words[0]?.start ?? 0;
}

export function Transcript(props: {
  segments: Segment[];
  currentTime: () => number;
  /** Total video length, or 0 before the player reports one. */
  duration: () => number;
  playing: () => boolean;
  playbackRate: () => number;
  onSeek: (secs: number) => void;
  onPlayPause: () => void;
  onPlaybackRate: (rate: number) => void;
}) {
  let container!: HTMLDivElement;
  // Whether the transcript auto-scrolls to track playback. Manual scrolling
  // turns it off; seeking or the resume button turns it back on.
  const [following, setFollowing] = createSignal(true);

  const speakers = createMemo(() => assignSpeakers(props.segments));
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
  // Where a skip lands. Duration is 0 until the player reports one, so only
  // clamp against the end once we know it.
  const jumpTarget = (delta: number) =>
    Math.min(
      props.duration() || Infinity,
      Math.max(0, props.currentTime() + delta),
    );
  const jump = (delta: number) => seek(jumpTarget(delta));
  // The rate one click away, so the button can say where it's headed.
  const nextRate = () => {
    const i = PLAYBACK_RATES.findIndex((r) => r === props.playbackRate());
    return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]!;
  };

  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => findMatches(props.segments, query()));
  // Which hit is focused. Jumping past either end wraps around.
  const [matchIndex, setMatchIndex] = createSignal(0);
  const currentMatch = createMemo(() => matches()[matchIndex()]);
  const matchesBySegment = createMemo(() => {
    const bySegment = new Map<number, Match[]>();
    for (const match of matches()) {
      const existing = bySegment.get(match.segment);
      if (existing) existing.push(match);
      else bySegment.set(match.segment, [match]);
    }
    return bySegment;
  });

  createEffect(on(matches, () => setMatchIndex(0), { defer: true }));

  const step = (delta: number) => {
    const count = matches().length;
    if (count === 0) return;
    setMatchIndex((i) => (i + delta + count) % count);
  };

  // Bring the focused hit into view. Searching takes over the scroll position,
  // so it also stops playback-following until the user resumes.
  createEffect(() => {
    if (!currentMatch()) return;
    const word = container.querySelector<HTMLElement>("[data-search-current]");
    if (!word) return;
    setFollowing(false);
    word.scrollIntoView({ block: "center", behavior: "smooth" });
  });

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
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <div class="flex items-center gap-2">
        <TextField class="flex-1" value={query()} onChange={setQuery}>
          <TextFieldInput
            type="search"
            placeholder="Search transcript"
            class="w-full"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                setQuery("");
              }
            }}
          />
        </TextField>
        <Show when={query().trim().length >= MIN_QUERY_LENGTH}>
          <span class="text-muted-foreground w-16 text-right text-sm tabular-nums">
            {matches().length === 0
              ? "No results"
              : `${matchIndex() + 1} / ${matches().length}`}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous match"
            disabled={matches().length === 0}
            onClick={() => step(-1)}
          >
            ↑
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next match"
            disabled={matches().length === 0}
            onClick={() => step(1)}
          >
            ↓
          </Button>
        </Show>
      </div>
      <div class="min-h-0 flex-1">
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
                  speaker={() => speakers().get(speakerKey(segment))}
                  status={() =>
                    i() < activeIndex()
                      ? "past"
                      : i() === activeIndex()
                        ? "active"
                        : "future"
                  }
                  currentTime={props.currentTime}
                  onSeek={seek}
                  matches={() => matchesBySegment().get(i()) ?? []}
                  currentMatch={currentMatch}
                />
              )}
            </For>
          </div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <span class="text-muted-foreground w-14 text-xs tabular-nums">
          {formatTimestamp(props.currentTime())}
        </span>
        <div class="flex flex-1 items-center justify-center gap-1">
          <ToolbarButton
            label="Change playback speed"
            tooltip={`Playback speed: ${props.playbackRate()}× → ${nextRate()}×`}
            size="sm"
            class="tabular-nums"
            onClick={() => props.onPlaybackRate(nextRate())}
          >
            {props.playbackRate()}×
          </ToolbarButton>
          <ToolbarButton
            label={`Back ${JUMP_SECS} seconds`}
            tooltip={`Jump back to ${formatTimestamp(jumpTarget(-JUMP_SECS))}`}
            onClick={() => jump(-JUMP_SECS)}
          >
            <SkipIcon back />
          </ToolbarButton>
          <ToolbarButton
            label={props.playing() ? "Pause" : "Play"}
            tooltip={props.playing() ? "Pause the video" : "Play the video"}
            onClick={() => props.onPlayPause()}
          >
            <Show when={props.playing()} fallback={<PlayIcon />}>
              <PauseIcon />
            </Show>
          </ToolbarButton>
          <ToolbarButton
            label={`Forward ${JUMP_SECS} seconds`}
            tooltip={`Jump ahead to ${formatTimestamp(jumpTarget(JUMP_SECS))}`}
            onClick={() => jump(JUMP_SECS)}
          >
            <SkipIcon />
          </ToolbarButton>
          {/* Disabled while following, since there's nowhere to return to. */}
          <ToolbarButton
            label="Return to playhead"
            tooltip="Scroll back to the playhead and resume following it"
            disabled={following()}
            onClick={() => setFollowing(true)}
          >
            <PlayheadIcon />
          </ToolbarButton>
        </div>
        <span class="text-muted-foreground w-14 text-right text-xs tabular-nums">
          <Show when={props.duration() > 0}>
            −{formatTimestamp(props.duration() - props.currentTime())}
          </Show>
        </span>
      </div>
    </div>
  );
}

/**
 * A playback control. `label` names the button for screen readers; `tooltip`
 * spells out what clicking it will do, and shows on hover or keyboard focus.
 */
function ToolbarButton(props: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: JSX.Element;
  size?: "sm" | "icon-sm";
  disabled?: boolean;
  class?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        as={Button}
        variant="ghost"
        size={props.size ?? "icon-sm"}
        class={props.class}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function Icon(props: { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function PlayIcon() {
  return (
    <Icon>
      <polygon points="6 3 20 12 6 21" fill="currentColor" />
    </Icon>
  );
}

function PauseIcon() {
  return (
    <Icon>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" />
    </Icon>
  );
}

/** A circular arrow labelled with the jump size; forward unless `back`. */
function SkipIcon(props: { back?: boolean }) {
  return (
    <Icon>
      <Show
        when={props.back}
        fallback={
          <>
            <path d="M21 3v6h-6" />
            <path d="M20.5 14.5a9 9 0 1 1-2.1-9.4L21 9" />
          </>
        }
      >
        <path d="M3 3v6h6" />
        <path d="M3.5 14.5a9 9 0 1 0 2.1-9.4L3 9" />
      </Show>
      <text
        x="12"
        y="17"
        text-anchor="middle"
        font-size="9"
        stroke="none"
        fill="currentColor"
      >
        {JUMP_SECS}
      </text>
    </Icon>
  );
}

function PlayheadIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
    </Icon>
  );
}

function SegmentBlock(props: {
  segment: Segment;
  speaker: () => SpeakerIdentity | undefined;
  status: () => SegmentStatus;
  currentTime: () => number;
  onSeek: (secs: number) => void;
  matches: () => Match[];
  currentMatch: () => Match | undefined;
}) {
  // Word index -> whether it belongs to a hit, and to the focused one.
  const highlights = createMemo(() => {
    const focused = props.currentMatch();
    const byWord = new Map<number, { current: boolean; first: boolean }>();
    for (const match of props.matches()) {
      const current = match === focused;
      for (let i = match.from; i <= match.to; i++) {
        byWord.set(i, { current, first: i === match.from });
      }
    }
    return byWord;
  });

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
    <div
      class="border-l-2 pl-3"
      style={{
        "border-color":
          speakerColor(props.speaker()?.colorSlot ?? null) ?? "var(--border)",
      }}
    >
      <div class="flex items-baseline gap-2 text-sm">
        <span class="flex items-baseline gap-1.5 font-semibold">
          <SpeakerSwatch speaker={props.speaker} />
          <Show
            when={props.speaker()?.person}
            fallback={props.speaker()?.label ?? "Unknown"}
          >
            {(person) => (
              <Link
                to="/people/$id"
                params={{ id: String(person().id) }}
                class="hover:underline"
              >
                {props.speaker()?.label}
              </Link>
            )}
          </Show>
        </span>
        <button
          type="button"
          class="text-muted-foreground text-xs tabular-nums hover:underline hover:cursor-pointer"
          onClick={() => props.onSeek(segmentStart(props.segment))}
        >
          {formatTimestamp(segmentStart(props.segment))}
        </button>
      </div>
      <p class="leading-relaxed">
        <Index each={props.segment.words}>
          {(word, i) => {
            const highlight = () => highlights().get(i);
            return (
              <>
                <span
                  class="cursor-pointer rounded-sm transition-opacity duration-300 data-playhead:bg-primary/10 hover:bg-primary/10 hover:opacity-100"
                  classList={{
                    "opacity-30": i > playheadIndex() && !highlight(),
                    "bg-yellow-200 dark:bg-yellow-500/30":
                      !!highlight() && !highlight()?.current,
                    "bg-yellow-400 dark:bg-yellow-500/70": !!highlight()?.current,
                  }}
                  data-playhead={i === playheadIndex() ? "" : undefined}
                  data-search-current={
                    highlight()?.current && highlight()?.first ? "" : undefined
                  }
                  onClick={() => props.onSeek(word().start)}
                >
                  {word().text}
                </span>
                {" "}
              </>
            );
          }}
        </Index>
      </p>
    </div>
  );
}

/**
 * Every case-insensitive occurrence of `query` in the transcript, in reading
 * order. Matching runs over each segment's words joined by spaces, so a query
 * can span word boundaries; a hit covers every word it touches.
 */
function findMatches(segments: Segment[], query: string): Match[] {
  const q = query.trim().toLowerCase();
  const matches: Match[] = [];
  if (q.length < MIN_QUERY_LENGTH) return matches;

  segments.forEach((segment, segmentIndex) => {
    let text = "";
    const wordStarts: number[] = [];
    for (const word of segment.words) {
      wordStarts.push(text.length);
      text += `${word.text.toLowerCase()} `;
    }
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + 1)) {
      matches.push({
        segment: segmentIndex,
        from: lastIndexAtOrBefore(wordStarts, at),
        to: lastIndexAtOrBefore(wordStarts, at + q.length - 1),
      });
    }
  });
  return matches;
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
