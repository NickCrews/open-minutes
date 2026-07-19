import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getPersonById, updatePersonName } from "~/features/people";
import { intervalToSecs } from "~/lib/format";
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
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Segments</h2>
      <div class="flex flex-col gap-3">
        <For
          each={person().segments}
          fallback={<p class="text-muted-foreground">No segments yet.</p>}
        >
          {(segment) => {
            const start = () =>
              segment.start_secs != null
                ? intervalToSecs(segment.start_secs)
                : null;
            const end = () =>
              segment.end_secs != null
                ? intervalToSecs(segment.end_secs)
                : null;
            return (
              <div class="flex items-start gap-2">
                <Show
                  when={segment.meeting.youtube_id && start() != null}
                  fallback={<div class="size-8 shrink-0" />}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="shrink-0 rounded-full"
                    aria-label={
                      audio.playingId() === segment.id
                        ? "Pause audio"
                        : "Play audio"
                    }
                    onClick={() =>
                      audio.toggle(
                        segment.id,
                        segment.meeting.youtube_id,
                        start()!,
                        end(),
                      )
                    }
                  >
                    <Show
                      when={audio.playingId() === segment.id}
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
                  <Link
                    to="/meetings/$id"
                    params={{ id: String(segment.meeting.id) }}
                    class="font-semibold hover:underline"
                  >
                    {segment.meeting.title || "(untitled)"}
                  </Link>
                  : {segment.text}
                </p>
              </div>
            );
          }}
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
