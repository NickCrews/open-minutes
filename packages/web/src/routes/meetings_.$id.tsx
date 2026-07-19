import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { VideoPlayer } from "~/components/video-player";
import { getMeetingById } from "~/features/meetings";
import { Speakers } from "~/features/meetings/speakers";
import { Transcript } from "~/features/meetings/transcript";
import { formatMeetingTime } from "~/lib/format";
import { type YTPlayer } from "~/lib/youtube";
import { db } from "~/server/db";

const fetchMeeting = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getMeetingById(db(), data));

export const Route = createFileRoute("/meetings_/$id")({
  loader: ({ params }) => fetchMeeting({ data: Number(params.id) }),
  component: MeetingPage,
});

function MeetingPage() {
  const meeting = Route.useLoaderData();
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [playbackRate, setPlaybackRate] = createSignal(1);
  const [player, setPlayer] = createSignal<YTPlayer>();
  // After a transcript-initiated seek, ignore polled times briefly so the
  // playhead doesn't flash back to the pre-seek position.
  let ignorePollsUntil = 0;

  const seekTo = (secs: number) => {
    setCurrentTime(secs);
    ignorePollsUntil = performance.now() + 800;
    player()?.seekTo(secs, true);
  };
  const onPolledTime = (secs: number) => {
    if (performance.now() < ignorePollsUntil) return;
    setCurrentTime(secs);
  };
  const togglePlay = () => {
    const p = player();
    if (!p) return;
    if (playing()) p.pauseVideo();
    else p.playVideo();
  };
  const changeRate = (rate: number) => {
    player()?.setPlaybackRate(rate);
    setPlaybackRate(rate);
  };

  return (
    <div class="flex h-[calc(100dvh-5.5rem)] flex-col gap-3">
      <header class="shrink-0">
        <h1 class="text-xl font-bold">{meeting().title || "(untitled)"}</h1>
        <p class="text-muted-foreground text-sm">
          <Link
            to="/bodies/$id"
            params={{ id: String(meeting().body.id) }}
            class="hover:underline"
          >
            {meeting().body.name}
          </Link>
          <Show when={meeting().start_time}>
            {(start) => <> — {formatMeetingTime(start())}</>}
          </Show>
        </p>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div class="flex min-h-0 shrink-0 flex-col gap-3 lg:w-3/5">
          <Show
            when={meeting().youtube_id}
            fallback={
              <div class="bg-muted text-muted-foreground flex aspect-video w-full shrink-0 items-center justify-center rounded-lg text-sm">
                No video available
              </div>
            }
          >
            {(videoId) => (
              <VideoPlayer
                videoId={videoId()}
                onPlayer={setPlayer}
                onTime={onPolledTime}
                onDuration={setDuration}
                onPlayingChange={setPlaying}
              />
            )}
          </Show>
          <Speakers segments={meeting().segments} />
          <Show when={meeting().description}>
            <p class="text-muted-foreground hidden min-h-0 overflow-y-auto whitespace-pre-line text-sm lg:block">
              {meeting().description}
            </p>
          </Show>
        </div>
        <Transcript
          segments={meeting().segments}
          currentTime={currentTime}
          duration={duration}
          playing={playing}
          playbackRate={playbackRate}
          onSeek={seekTo}
          onPlayPause={togglePlay}
          onPlaybackRate={changeRate}
        />
      </div>
    </div>
  );
}
