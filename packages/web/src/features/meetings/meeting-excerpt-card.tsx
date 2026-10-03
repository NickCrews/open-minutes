import { Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  compareMeetingsNewestFirst,
  formatMeetingDate,
  type MeetingWhen,
} from "@open-minutes/core/meeting-date";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";
import { formatTimestamp, intervalToSecs } from "~/lib/format";
import { db } from "~/server/db";
import { z } from "zod";
import { getMeetingSegments } from ".";
import { previewText } from "./excerpt";
import type { HiddenPlayer } from "./hidden-player";
import type { Segment } from "./speaker-identity";
import { MIN_QUERY_LENGTH } from "./transcript";
import { TranscriptExcerpt } from "./transcript-excerpt";

/** Hits a collapsed card previews before "N more". */
const PREVIEW_LIMIT = 3;

/** A meeting's whole transcript, fetched when its card first opens. */
const fetchMeetingSegments = createServerFn({ method: "GET" })
  .inputValidator(z.int().positive())
  .handler(({ data }) => getMeetingSegments(db(), data));

export type ExcerptMeeting = MeetingWhen & {
  id: number;
  title: string | null;
  youtube_id: string;
};

/**
 * A segment a page wants to show from a meeting: one a person spoke, or one
 * matching a search. Only its text is needed up front; the words come with
 * the full transcript when the card opens.
 */
export type ExcerptHit = {
  id: number;
  start_secs: string | null;
  text: string | null;
  person?: { id: number; name: string | null } | null;
  meeting: ExcerptMeeting;
};

export type MeetingHits<H extends ExcerptHit> = {
  meeting: H["meeting"];
  hits: H[];
};

/**
 * Collects hits into one group per meeting: most recent meeting first, and
 * within a meeting in the order they were spoken. Meetings with no date sort
 * last, since we can't place them in time; on the same day, a known time
 * sorts before an unknown one.
 */
export function groupByMeeting<H extends ExcerptHit>(
  hits: H[],
): MeetingHits<H>[] {
  const groups = new Map<number, MeetingHits<H>>();
  for (const hit of hits) {
    let group = groups.get(hit.meeting.id);
    if (!group) {
      group = { meeting: hit.meeting, hits: [] };
      groups.set(hit.meeting.id, group);
    }
    group.hits.push(hit);
  }
  for (const group of groups.values()) {
    group.hits.sort((a, b) => (hitStart(a) ?? 0) - (hitStart(b) ?? 0));
  }
  return [...groups.values()].sort(
    (a, b) =>
      compareMeetingsNewestFirst(a.meeting, b.meeting) ||
      b.meeting.id - a.meeting.id,
  );
}

const hitStart = (hit: ExcerptHit) =>
  hit.start_secs != null ? intervalToSecs(hit.start_secs) : null;

/**
 * One meeting's hits, as a card. Collapsed, it previews the first few hits'
 * text; opened, it shows every hit in the context of the meeting's
 * transcript, with the segments between them folded away and playable audio.
 * The transcript is fetched the first time the card opens, and kept for as
 * long as the page is.
 *
 * This is how any page other than the meeting page itself shows transcript:
 * /people/:id pins a person's segments, /search pins the matching ones.
 */
export function MeetingExcerptCard(props: {
  meeting: ExcerptMeeting;
  hits: ExcerptHit[];
  /** What a hit is called in the header's count, eg ["match", "matches"]. */
  noun: [one: string, other: string];
  /** Highlights this query's hits in the preview and the excerpt. */
  query?: string;
  /** Names who spoke each hit; pointless when they're all one person. */
  showSpeakers?: boolean;
  player: HiddenPlayer;
  defaultExpanded?: boolean;
}) {
  // Only the initial value is wanted; the card is the user's to toggle after.
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false);
  const [transcript, setTranscript] = createSignal<Segment[]>();
  const [failed, setFailed] = createSignal(false);
  const count = () => props.hits.length;
  const hitIds = createMemo(() => new Set(props.hits.map((h) => h.id)));
  const pinned = (segments: Segment[]) =>
    segments.flatMap((segment, i) => (hitIds().has(segment.id) ? [i] : []));

  let loading = false;
  // Effects don't run during SSR, so a card that starts open fetches once it
  // reaches the browser.
  createEffect(() => {
    if (!expanded() || transcript() || failed() || loading) return;
    loading = true;
    fetchMeetingSegments({ data: props.meeting.id })
      .then(setTranscript, () => setFailed(true))
      .finally(() => (loading = false));
  });

  return (
    <Card class="gap-0 py-0">
      <button
        type="button"
        aria-expanded={expanded()}
        onClick={() => setExpanded(!expanded())}
        class="hover:bg-muted/50 cursor-pointer rounded-xl text-left"
      >
        <CardHeader class="py-4">
          <CardTitle class="flex items-center gap-2">
            <ExpandChevron expanded={expanded()} />
            {props.meeting.title || "(untitled)"}
          </CardTitle>
          <CardDescription class="pl-6">
            {formatMeetingDate(props.meeting) ?? "Date unknown"}
            {" · "}
            {count()} {props.noun[count() === 1 ? 0 : 1]}
          </CardDescription>
        </CardHeader>
        <Show when={!expanded()}>
          <div class="flex flex-col gap-2 px-6 pb-4">
            <HitPreviews
              hits={props.hits.slice(0, PREVIEW_LIMIT)}
              query={props.query}
              showSpeakers={props.showSpeakers}
              clamp
            />
            <Show when={count() > PREVIEW_LIMIT}>
              <span class="text-muted-foreground pl-10 text-xs">
                {count() - PREVIEW_LIMIT} more
              </span>
            </Show>
          </div>
        </Show>
      </button>
      <Show when={expanded()}>
        <CardContent class="flex flex-col gap-4 border-t py-4">
          <Switch>
            <Match when={transcript()}>
              {(segments) => (
                <TranscriptExcerpt
                  meetingId={props.meeting.id}
                  youtubeId={props.meeting.youtube_id}
                  segments={segments()}
                  pinned={pinned(segments())}
                  query={props.query}
                  emptyMessage={`No ${props.noun[1]} found in the transcript.`}
                  player={props.player}
                />
              )}
            </Match>
            <Match when={failed()}>
              <p class="text-destructive text-sm">
                Couldn't load the transcript.{" "}
                <button
                  type="button"
                  class="cursor-pointer underline"
                  onClick={() => setFailed(false)}
                >
                  Try again
                </button>
              </p>
            </Match>
            <Match when={true}>
              {/* The hits' text, which the page already has, stands in until
                  the full transcript arrives. */}
              <div class="flex flex-col gap-2" aria-busy="true">
                <HitPreviews
                  hits={props.hits}
                  query={props.query}
                  showSpeakers={props.showSpeakers}
                />
              </div>
            </Match>
          </Switch>
          <Link
            to="/meetings/$id"
            params={{ id: String(props.meeting.id) }}
            class="text-sm font-medium hover:underline"
          >
            View meeting →
          </Link>
        </CardContent>
      </Show>
    </Card>
  );
}

/**
 * Hits as plain text, indented to line up with the excerpt's text past its
 * play buttons. `clamp` cuts each to a few lines, for a collapsed card.
 */
function HitPreviews(props: {
  hits: ExcerptHit[];
  query?: string;
  showSpeakers?: boolean;
  clamp?: boolean;
}) {
  return (
    <For each={props.hits}>
      {(hit) => (
        <div class="pl-10">
          <div class="text-muted-foreground flex items-baseline gap-2 text-xs">
            <Show when={props.showSpeakers}>
              <span class="text-foreground text-sm font-semibold">
                {hit.person ? hit.person.name || "(unnamed)" : "Unknown"}
              </span>
            </Show>
            <Show when={hitStart(hit)}>
              {(secs) => (
                <span class="tabular-nums">{formatTimestamp(secs())}</span>
              )}
            </Show>
          </div>
          <p
            class="text-muted-foreground leading-relaxed"
            classList={{ "line-clamp-3": props.clamp }}
          >
            <Highlighted
              text={
                props.clamp
                  ? previewText(hit.text ?? "", props.query)
                  : (hit.text ?? "")
              }
              query={props.query}
            />
          </p>
        </div>
      )}
    </For>
  );
}

/** `text` with each case-insensitive occurrence of `query` marked. */
function Highlighted(props: { text: string; query?: string }) {
  const parts = createMemo(() => {
    const q = props.query?.trim().toLowerCase() ?? "";
    if (q.length < MIN_QUERY_LENGTH) return [{ text: props.text, hit: false }];
    const lower = props.text.toLowerCase();
    const result: { text: string; hit: boolean }[] = [];
    let from = 0;
    for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
      if (at > from)
        result.push({ text: props.text.slice(from, at), hit: false });
      result.push({ text: props.text.slice(at, at + q.length), hit: true });
      from = at + q.length;
    }
    if (from < props.text.length) {
      result.push({ text: props.text.slice(from), hit: false });
    }
    return result;
  });
  return (
    <For each={parts()}>
      {(part) => (
        <Show when={part.hit} fallback={part.text}>
          <mark class="text-foreground rounded-sm bg-yellow-200 dark:bg-yellow-500/30">
            {part.text}
          </mark>
        </Show>
      )}
    </For>
  );
}

/** Chevron marking a collapsible section: points down when collapsed, flips up when open. */
function ExpandChevron(props: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class="text-muted-foreground size-4 shrink-0 transition-transform"
      classList={{ "-scale-y-100": props.expanded }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
