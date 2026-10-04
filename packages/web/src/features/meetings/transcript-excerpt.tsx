import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onMount,
  Show,
} from "solid-js";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { Button } from "~/components/button";
import { PauseIcon, PlayIcon } from "~/components/icons";
import { assignSpeakers, type Segment, speakerKey } from "./speaker-identity";
import {
  findMatches,
  lastIndexAtOrBefore,
  type Match,
  SegmentBlock,
  segmentStart,
} from "./transcript";
import { intervalToSecs } from "~/lib/format";
import {
  excerptItems,
  type Gap,
  REVEAL_STEP,
  type Reveal,
  visibleIndices,
} from "./excerpt";
import type { HiddenPlayer } from "./hidden-player";

/** When a segment's speech ends, falling back to its words' onsets. */
function segmentEnd(segment: Segment): number {
  const fromInterval = segment.end_secs
    ? intervalToSecs(segment.end_secs)
    : null;
  if (fromInterval != null) return fromInterval;
  const last = segment.words[segment.words.length - 1];
  return last ? last.start + LAST_WORD_DURATION_SEC : segmentStart(segment);
}

/**
 * One meeting's transcript cut down to its pinned segments, with the segments
 * between them folded into gaps that open on demand. Segments render with the
 * meeting page's own `SegmentBlock`, so speaker names, colors and hover cards,
 * word-by-word playback highlighting, and search-hit highlighting read the
 * same here.
 *
 * The caller decides what to pin: /people/:id pins a person's segments, and a
 * search result can pin the segment its hit is in and pass the `query`.
 *
 * `segments` is the whole transcript, in order: speaker placeholder names and
 * colors are assigned over all of it, so they match the meeting page.
 */
export function TranscriptExcerpt(props: {
  meetingId: number;
  youtubeId: string;
  segments: Segment[];
  /** Indices into `segments` of the segments always shown, in any order. */
  pinned: number[];
  /** Highlights this query's hits, as the meeting page's search does. */
  query?: string;
  /** Shown when nothing is pinned. */
  emptyMessage?: string;
  player: HiddenPlayer;
}) {
  const speakers = createMemo(() => assignSpeakers(props.segments));
  const starts = createMemo(() => props.segments.map(segmentStart));
  const matches = createMemo(() => {
    const bySegment = new Map<number, Match[]>();
    if (!props.query) return bySegment;
    for (const match of findMatches(props.segments, props.query)) {
      bySegment.set(match.segment, [
        ...(bySegment.get(match.segment) ?? []),
        match,
      ]);
    }
    return bySegment;
  });

  const [reveals, setReveals] = createSignal<ReadonlyMap<number, Reveal>>(
    new Map(),
  );
  const items = createMemo(() =>
    excerptItems(props.segments.length, props.pinned, reveals()),
  );
  const visible = createMemo(() => visibleIndices(items()));
  // Rows are keyed by strings rather than the item objects, which are rebuilt
  // on every reveal: the list then moves existing rows instead of remounting
  // them. "s<index>" is a segment, "g<key>" a gap.
  const keys = createMemo(() =>
    items().map((item) =>
      item.kind === "gap" ? `g${item.gap.key}` : `s${item.index}`,
    ),
  );
  const gaps = createMemo(
    () =>
      new Map(
        items().flatMap((item) =>
          item.kind === "gap" ? [[item.gap.key, item.gap] as const] : [],
        ),
      ),
  );

  const reveal = (gapKey: number, head: number, tail: number) =>
    setReveals((current) => {
      const next = new Map(current);
      const was = current.get(gapKey) ?? { head: 0, tail: 0 };
      const size = gaps().get(gapKey)?.size ?? 0;
      // Clamped, so "hide" after over-asking folds exactly what's shown.
      next.set(gapKey, {
        head: Math.min(size, was.head + head),
        tail: Math.min(size, was.tail + tail),
      });
      return next;
    });
  const fold = (gapKey: number) =>
    setReveals((current) => {
      const next = new Map(current);
      next.delete(gapKey);
      return next;
    });

  const isLoaded = () => props.player.meetingId() === props.meetingId;
  // The segment at the playhead, when this meeting is the one playing.
  const activeIndex = createMemo(() =>
    isLoaded() ? lastIndexAtOrBefore(starts(), props.player.currentTime()) : -1,
  );

  // Playback runs on through consecutive shown segments and stops where the
  // excerpt skips ahead, so it never plays speech the reader can't see.
  const shouldStop = (secs: number) => {
    const i = lastIndexAtOrBefore(starts(), secs);
    if (i < 0) return false;
    if (!visible().has(i)) return true;
    if (visible().has(i + 1)) return false;
    return secs >= segmentEnd(props.segments[i]!);
  };
  const playFrom = (secs: number) =>
    props.player.play(
      { id: props.meetingId, youtubeId: props.youtubeId },
      secs,
      shouldStop,
    );
  const canPlay = () => props.youtubeId !== "";
  // Get the audio loading while the reader looks for something to play.
  onMount(() => {
    if (canPlay()) {
      props.player.prepare({ id: props.meetingId, youtubeId: props.youtubeId });
    }
  });

  const SegmentRow = (row: { index: number }) => {
    const segment = props.segments[row.index]!;
    const active = () => activeIndex() === row.index;
    const playing = () => active() && props.player.playing();
    return (
      <div class="flex items-start gap-2">
        <Show when={canPlay()} fallback={<div class="size-8 shrink-0" />}>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 rounded-full"
            aria-label={playing() ? "Pause audio" : "Play audio"}
            onClick={() => {
              if (playing()) props.player.pause();
              // Paused partway through: pick up where it left off.
              else if (active()) playFrom(props.player.currentTime());
              else playFrom(segmentStart(segment));
            }}
          >
            <Show when={playing()} fallback={<PlayIcon />}>
              <PauseIcon />
            </Show>
          </Button>
        </Show>
        <div class="min-w-0 flex-1">
          <SegmentBlock
            segment={segment}
            speaker={() => speakers().get(speakerKey(segment))}
            // Only the segment at the playhead fades its unspoken words; the
            // rest read in full, as an excerpt should.
            status={() => (active() ? "active" : "past")}
            currentTime={props.player.currentTime}
            onSeek={(secs) => {
              if (canPlay()) playFrom(secs);
            }}
            matches={() => matches().get(row.index) ?? []}
          />
        </div>
      </div>
    );
  };

  return (
    <div class="flex flex-col gap-4">
      <For
        each={keys()}
        fallback={
          <p class="text-muted-foreground text-sm">
            {props.emptyMessage ?? "Nothing to show in the transcript."}
          </p>
        }
      >
        {(key) => (
          <Show
            when={key.startsWith("g")}
            fallback={<SegmentRow index={Number(key.slice(1))} />}
          >
            <GapControl
              gap={gaps().get(Number(key.slice(1)))!}
              onReveal={(head, tail) =>
                reveal(Number(key.slice(1)), head, tail)
              }
              onFold={() => fold(Number(key.slice(1)))}
            />
          </Show>
        )}
      </For>
    </div>
  );
}

/**
 * The fold for one gap of unpinned segments: how many are hidden, and
 * buttons to open more of them or to fold them all away again.
 */
function GapControl(props: {
  gap: Gap;
  onReveal: (head: number, tail: number) => void;
  onFold: () => void;
}) {
  const hidden = () => props.gap.hidden;
  const plural = (n: number) => (n === 1 ? "segment" : "segments");
  // Small gaps open in one go; stepping through them would be busywork.
  const stepped = () => hidden() > REVEAL_STEP;
  // "Earlier" grows the gap's bottom edge upward from the segment below it;
  // "later" grows its top edge downward from the segment above it.
  const canEarlier = () => props.gap.position !== "after";
  const canLater = () => props.gap.position !== "before";
  const showAll = () =>
    props.gap.position === "before"
      ? props.onReveal(0, props.gap.size)
      : props.onReveal(props.gap.size, 0);

  return (
    <div class="text-muted-foreground flex items-center gap-2 text-xs">
      <span class="h-px flex-1 border-t border-dashed" aria-hidden="true" />
      <Show when={hidden() > 0}>
        <span class="tabular-nums">
          {hidden()} {plural(hidden())} hidden
        </span>
        <Show
          when={stepped()}
          fallback={<GapButton onClick={showAll}>Show</GapButton>}
        >
          <Show when={canLater()}>
            <GapButton onClick={() => props.onReveal(REVEAL_STEP, 0)}>
              Next {REVEAL_STEP}
            </GapButton>
          </Show>
          <Show when={canEarlier()}>
            <GapButton onClick={() => props.onReveal(0, REVEAL_STEP)}>
              Previous {REVEAL_STEP}
            </GapButton>
          </Show>
          <GapButton onClick={showAll}>Show all</GapButton>
        </Show>
      </Show>
      <Show when={props.gap.revealed > 0}>
        <GapButton onClick={() => props.onFold()}>
          Hide {props.gap.revealed} {plural(props.gap.revealed)}
        </GapButton>
      </Show>
      <span class="h-px flex-1 border-t border-dashed" aria-hidden="true" />
    </div>
  );
}

function GapButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground h-6 px-2 text-xs"
      onClick={() => props.onClick()}
    >
      {props.children}
    </Button>
  );
}
