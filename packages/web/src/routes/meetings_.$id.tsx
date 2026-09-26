import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { Button } from "~/components/button";
import { Sheet, SheetContent, SheetTrigger } from "~/components/sheet";
import { VideoPlayer } from "~/components/video-player";
import { getMeetingById } from "~/features/meetings";
import { Duration } from "~/features/meetings/duration";
import {
  MeetingPane,
  type MeetingPaneTab,
} from "~/features/meetings/meeting-pane";
import { MeetingDateTime } from "~/features/meetings/meeting-date-time";
import { Transcript } from "~/features/meetings/transcript";
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
  const router = useRouter();
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

  const [paneTab, setPaneTab] = createSignal<MeetingPaneTab>("info");
  const [sheetOpen, setSheetOpen] = createSignal(false);
  const pane = (cls: string) => (
    <MeetingPane
      title={meeting().title || "(untitled)"}
      description={meeting().description}
      segments={meeting().segments}
      tab={paneTab()}
      onTabChange={setPaneTab}
      class={cls}
    />
  );

  // The page fills the viewport below the nav (3rem) and main's padding
  // (2 × 1rem) exactly, so only the transcript scrolls: the video stays put
  // above it and the playback controls stay pinned below it, on every screen.
  return (
    <div class="flex h-[calc(100dvh-5rem)] flex-col gap-3">
      <header class="flex shrink-0 items-start gap-2">
        <div class="min-w-0 flex-1">
          {/* Phones get a single line; the Info tab has the full title. */}
          <h1 class="truncate font-bold lg:whitespace-normal lg:text-xl">
            {meeting().title || "(untitled)"}
          </h1>
          {/* A div, not a p: the dev-only date editor puts a form in
              here, and a browser closes an open <p> the moment it meets flow
              content, which would split this line in two during hydration. */}
          <div class="text-muted-foreground text-xs lg:text-sm">
            <Link
              to="/bodies/$id"
              params={{ id: String(meeting().body.id) }}
              class="hover:underline"
            >
              {meeting().body.name}
            </Link>
            <MeetingDateTime
              meetingId={meeting().id}
              date={meeting().date}
              time={meeting().time}
              timezone={meeting().body.timezone}
              prefix=" — "
              onSaved={() => void router.invalidate()}
            />
            <Duration durationSecs={meeting().duration_secs} prefix=" — " />
          </div>
        </div>
        {/* Phones have no room beside the transcript for the side pane, so
            the same pane opens as a bottom sheet instead. */}
        <Sheet open={sheetOpen()} onOpenChange={setSheetOpen}>
          <SheetTrigger
            as={Button}
            variant="outline"
            size="sm"
            class="lg:hidden"
          >
            Details
          </SheetTrigger>
          <SheetContent title="Meeting details" class="lg:hidden">
            {pane("flex-1")}
          </SheetContent>
        </Sheet>
      </header>
      {/* Video above transcript on portrait phones; side by side otherwise,
          since stacking on a short screen (a phone held sideways) would leave
          the transcript no height at all. */}
      <div class="flex min-h-0 flex-1 flex-col gap-3 landscape:flex-row landscape:gap-4 lg:flex-row lg:gap-4">
        <div class="flex shrink-0 flex-col gap-4 landscape:min-h-0 landscape:w-2/5 lg:min-h-0 lg:w-3/5 lg:landscape:w-3/5">
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
          {pane("hidden flex-1 lg:flex")}
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
