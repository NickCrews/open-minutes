import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button } from "~/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getPersonById, updatePersonName } from "~/features/people";
import {
  formatMeetingTime,
  formatTimestamp,
  intervalToSecs,
} from "~/lib/format";
import {
  loadYouTubeIframeApi,
  PlayerState,
  type YTPlayer,
} from "~/lib/youtube";
import { db } from "~/server/db";

const fetchPerson = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getPersonById(db(), data));

const savePersonName = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number; name: string }) => input)
  .handler(({ data }) => updatePersonName(db(), data.id, data.name));

export const Route = createFileRoute("/people_/$id")({
  loader: ({ params }) => fetchPerson({ data: Number(params.id) }),
  component: PersonPage,
});

function PersonPage() {
  const person = Route.useLoaderData();
  const router = useRouter();
  const audio = createHiddenAudio();
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
          <div class="mb-6 flex items-center gap-3">
            <h1 class="text-2xl font-bold">{person().name || "(unnamed)"}</h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </div>
        }
      >
        <form
          class="mb-6 flex items-center gap-2"
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
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Meetings</h2>
      <div class="flex flex-col gap-4">
        <For
          each={groupByMeeting(person().segments)}
          fallback={<p class="text-muted-foreground">No segments yet.</p>}
        >
          {(group) => <MeetingCard group={group} audio={audio} />}
        </For>
      </div>
      <div
        ref={audio.setHost}
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
 * Meetings with no start time sort last, since we can't place them in time.
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
  return [...groups.values()].sort((a, b) => {
    const aTime = a.meeting.start_time?.getTime();
    const bTime = b.meeting.start_time?.getTime();
    if (aTime == null || bTime == null) {
      if (aTime == null && bTime == null) return b.meeting.id - a.meeting.id;
      return aTime == null ? 1 : -1;
    }
    return bTime - aTime;
  });
}

const segmentStart = (segment: PersonSegment) =>
  segment.start_secs != null ? intervalToSecs(segment.start_secs) : null;

const segmentEnd = (segment: PersonSegment) =>
  segment.end_secs != null ? intervalToSecs(segment.end_secs) : null;

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

/** One meeting the person spoke in, expandable to reveal all their segments. */
function MeetingCard(props: {
  group: MeetingGroup;
  audio: ReturnType<typeof createHiddenAudio>;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const count = () => props.group.segments.length;

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
            {props.group.meeting.start_time
              ? formatMeetingTime(
                  props.group.meeting.start_time,
                  props.group.meeting.body.timezone,
                )
              : "Date unknown"}
            {" · "}
            {count()} {count() === 1 ? "segment" : "segments"}
          </CardDescription>
        </CardHeader>
      </button>
      <Show when={expanded()}>
        <CardContent class="flex flex-col gap-3 border-t py-4">
          <For each={props.group.segments}>
            {(segment) => <SegmentRow segment={segment} audio={props.audio} />}
          </For>
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

function SegmentRow(props: {
  segment: PersonSegment;
  audio: ReturnType<typeof createHiddenAudio>;
}) {
  const start = () => segmentStart(props.segment);
  const playing = () => props.audio.playingId() === props.segment.id;

  return (
    <div class="flex items-start gap-2">
      <Show
        when={props.segment.meeting.youtube_id && start() != null}
        fallback={<div class="size-8 shrink-0" />}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          class="shrink-0 rounded-full"
          aria-label={playing() ? "Pause audio" : "Play audio"}
          onClick={() =>
            props.audio.toggle(
              props.segment.id,
              props.segment.meeting.youtube_id,
              start()!,
              segmentEnd(props.segment),
            )
          }
        >
          <Show
            when={playing()}
            fallback={
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          </Show>
        </Button>
      </Show>
      <p class="leading-relaxed">
        <Show when={start() != null}>
          <span class="text-muted-foreground mr-2 font-mono text-sm">
            {formatTimestamp(start()!)}
          </span>
        </Show>
        {props.segment.text}
      </p>
    </div>
  );
}

/**
 * An invisible YouTube player used for audio-only playback of segments.
 * Created lazily on the first play click; switching segments reuses the
 * same player. Playback stops at the end of the segment; playing a
 * finished segment again restarts it from the beginning.
 */
function createHiddenAudio() {
  const [playingId, setPlayingId] = createSignal<number | null>(null);
  let host: HTMLDivElement | undefined;
  let playerPromise: Promise<YTPlayer> | undefined;
  // Segment whose audio is (being) loaded into the player.
  let loadedId: number | null = null;
  // Playhead position at which to stop, if the segment has an end time.
  let stopAt: number | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    clearInterval(poll);
    void playerPromise?.then((player) => player.destroy());
  });

  const createPlayer = (videoId: string, startSecs: number) =>
    loadYouTubeIframeApi().then(
      (YT) =>
        new Promise<YTPlayer>((resolve) => {
          const mount = document.createElement("div");
          host?.appendChild(mount);
          const player = new YT.Player(mount, {
            videoId,
            playerVars: {
              autoplay: 1,
              start: Math.floor(startSecs),
              playsinline: 1,
            },
            events: {
              onReady: () => {
                // The IFrame API has no timeupdate event, so poll for the
                // playhead crossing the end of the segment.
                poll = setInterval(() => {
                  if (playingId() === null || stopAt === null) return;
                  if (player.getCurrentTime() >= stopAt) {
                    player.pauseVideo();
                    setPlayingId(null);
                    // Forget the segment so playing it again restarts it.
                    loadedId = null;
                  }
                }, 250);
                resolve(player);
              },
              onStateChange: (event) => {
                if (event.data === PlayerState.playing) setPlayingId(loadedId);
                else if (
                  event.data === PlayerState.paused ||
                  event.data === PlayerState.ended
                )
                  setPlayingId(null);
              },
            },
          });
        }),
    );

  const toggle = async (
    segmentId: number,
    videoId: string,
    startSecs: number,
    endSecs: number | null,
  ) => {
    if (playingId() === segmentId) {
      setPlayingId(null);
      void playerPromise?.then((player) => {
        if (playingId() === null) player.pauseVideo();
      });
      return;
    }
    setPlayingId(segmentId);
    if (!playerPromise) {
      loadedId = segmentId;
      stopAt = endSecs;
      playerPromise = createPlayer(videoId, startSecs);
      return;
    }
    const player = await playerPromise;
    if (disposed) return;
    if (loadedId === segmentId) {
      stopAt = endSecs;
      player.playVideo();
    } else {
      loadedId = segmentId;
      // Set stopAt only after loading the new video, so the poll never
      // compares the old video's playhead against the new segment's end.
      player.loadVideoById({ videoId, startSeconds: startSecs });
      stopAt = endSecs;
    }
  };

  return {
    playingId,
    toggle,
    setHost: (el: HTMLDivElement) => (host = el),
  };
}
