import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Button } from "~/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getMeetingSegments } from "~/features/meetings";
import type { Segment } from "~/features/meetings/speaker-identity";
import { getPersonById, updatePersonName } from "~/features/people";
import { Bio } from "~/features/people/bio";
import {
  createHiddenPlayer,
  type HiddenPlayer,
} from "~/features/people/hidden-player";
import { MeetingExcerpt } from "~/features/people/meeting-excerpt";
import { assertCanEdit, canEdit } from "~/lib/permissions";
import { formatMeetingDate, intervalToSecs } from "~/lib/format";
import { db } from "~/server/db";
import { compareMeetingsNewestFirst } from "@open-minutes/core/meeting-date";

const fetchPerson = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getPersonById(db(), data));

/** A meeting's whole transcript, fetched when its card first opens. */
const fetchMeetingSegments = createServerFn({ method: "GET" })
  .inputValidator((meetingId: number) => meetingId)
  .handler(({ data }) => getMeetingSegments(db(), data));

/** Guarded on both sides of the wire by the same `canEdit` that hides the button. */
const savePersonName = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number; name: string }) => input)
  .handler(({ data }) => {
    assertCanEdit("names");
    return updatePersonName(db(), data.id, data.name);
  });

export const Route = createFileRoute("/people_/$id")({
  loader: ({ params }) => fetchPerson({ data: Number(params.id) }),
  component: PersonPage,
});

function PersonPage() {
  const person = Route.useLoaderData();
  const router = useRouter();
  const player = createHiddenPlayer();
  const groups = createMemo(() => groupByMeeting(person().segments));
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const save = async (name: string) => {
    setSaving(true);
    try {
      await savePersonName({ data: { id: person().id, name } });
      await router.invalidate();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="mx-auto max-w-3xl">
      <Show
        when={editing()}
        fallback={
          <div class="mb-2 flex items-center gap-3">
            <h1 class="text-2xl font-bold">{person().name || "(unnamed)"}</h1>
            <Show when={canEdit()}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Show>
          </div>
        }
      >
        <form
          class="mb-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            void save(String(name ?? ""));
          }}
        >
          <TextField
            name="name"
            defaultValue={person().name ?? ""}
            class="flex-1"
          >
            <TextFieldInput
              type="text"
              placeholder="Person's name"
              autofocus
              class="text-2xl font-bold md:text-2xl"
            />
          </TextField>
          <Button type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving()}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      </Show>
      <Bio personId={person().id} bio={person().bio} />
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Meetings</h2>
      <div class="flex flex-col gap-4">
        <For
          each={groups()}
          fallback={<p class="text-muted-foreground">No segments yet.</p>}
        >
          {(group) => (
            <MeetingCard
              personId={person().id}
              group={group}
              player={player}
              // Nothing to choose between, so skip the click.
              defaultExpanded={groups().length === 1}
            />
          )}
        </For>
      </div>
      <div
        ref={player.setHost}
        aria-hidden="true"
        class="pointer-events-none fixed right-0 bottom-0 h-px w-px overflow-hidden opacity-0"
      />
    </div>
  );
}

type Person = Awaited<ReturnType<typeof getPersonById>>;
type PersonSegment = Person["segments"][number];
type MeetingGroup = {
  meeting: PersonSegment["meeting"];
  segments: PersonSegment[];
};

/**
 * Collects a person's segments into one group per meeting: most recent meeting
 * first, and within a meeting the segments in the order they were spoken.
 * Meetings with no date sort last, since we can't place them in time; on the
 * same day, a known time sorts before an unknown one.
 */
function groupByMeeting(segments: PersonSegment[]): MeetingGroup[] {
  const groups = new Map<number, MeetingGroup>();
  for (const segment of segments) {
    let group = groups.get(segment.meeting.id);
    if (!group) {
      group = { meeting: segment.meeting, segments: [] };
      groups.set(segment.meeting.id, group);
    }
    group.segments.push(segment);
  }
  for (const group of groups.values()) {
    group.segments.sort(
      (a, b) => (segmentStart(a) ?? 0) - (segmentStart(b) ?? 0),
    );
  }
  return [...groups.values()].sort(
    (a, b) =>
      compareMeetingsNewestFirst(a.meeting, b.meeting) ||
      b.meeting.id - a.meeting.id,
  );
}

const segmentStart = (segment: PersonSegment) =>
  segment.start_secs != null ? intervalToSecs(segment.start_secs) : null;

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

/**
 * One meeting the person spoke in, expandable to their segments in context.
 * The meeting's transcript is fetched the first time the card opens, and kept
 * for as long as the page is.
 */
function MeetingCard(props: {
  personId: number;
  group: MeetingGroup;
  player: HiddenPlayer;
  defaultExpanded: boolean;
}) {
  // Only the initial value is wanted; the card is the user's to toggle after.
  const [expanded, setExpanded] = createSignal(props.defaultExpanded);
  const [transcript, setTranscript] = createSignal<Segment[]>();
  const [failed, setFailed] = createSignal(false);
  const count = () => props.group.segments.length;

  let loading = false;
  // Effects don't run during SSR, so a card that starts open fetches once it
  // reaches the browser.
  createEffect(() => {
    if (!expanded() || transcript() || failed() || loading) return;
    loading = true;
    fetchMeetingSegments({ data: props.group.meeting.id })
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
            {props.group.meeting.title || "(untitled)"}
          </CardTitle>
          <CardDescription class="pl-6">
            {formatMeetingDate(props.group.meeting) ?? "Date unknown"}
            {" · "}
            {count()} {count() === 1 ? "segment" : "segments"}
          </CardDescription>
        </CardHeader>
      </button>
      <Show when={expanded()}>
        <CardContent class="flex flex-col gap-4 border-t py-4">
          <Switch>
            <Match when={transcript()}>
              {(segments) => (
                <MeetingExcerpt
                  personId={props.personId}
                  meetingId={props.group.meeting.id}
                  youtubeId={props.group.meeting.youtube_id}
                  segments={segments()}
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
              {/* The person's own words, which the page already has, stand in
                  until the full transcript arrives. */}
              <div class="flex flex-col gap-4" aria-busy="true">
                <For each={props.group.segments}>
                  {(segment) => (
                    <p class="text-muted-foreground pl-10 leading-relaxed">
                      {segment.text}
                    </p>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
          <Link
            to="/meetings/$id"
            params={{ id: String(props.group.meeting.id) }}
            class="text-sm font-medium hover:underline"
          >
            View meeting →
          </Link>
        </CardContent>
      </Show>
    </Card>
  );
}
