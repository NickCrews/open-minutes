import { createSignal, onCleanup } from "solid-js";
import { createYouTubeController, type Tick } from "~/lib/youtube";

/** A meeting's video, as the hidden player needs to know it. */
export type PlayableMeeting = { id: number; youtubeId: string };

/**
 * An invisible YouTube player for audio-only playback of meeting excerpts, one
 * shared by every meeting on the page: a {@link createYouTubeController} in a
 * host the page keeps out of sight. Its embed is made on the first play;
 * playing another meeting loads its video into the same embed.
 *
 * It polls the playhead like the meeting page's visible player does, so an
 * excerpt can highlight words as they are spoken. Each play hands over a
 * `shouldStop` check, run against the playhead on every poll, which is how an
 * excerpt stops playback where its shown segments run out.
 */
export function createHiddenPlayer() {
  const [meetingId, setMeetingId] = createSignal<number | null>(null);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let shouldStop: ((secs: number) => boolean) | undefined;
  // The playhead position just asked for. Until the player reports reaching
  // it, polled times are the old position, so they neither move the
  // highlight nor get checked against `shouldStop`.
  let pendingSeek: number | null = null;

  const onTick = ({ secs, state }: Tick) => {
    // Unstarted or cued, it reports 0 rather than where it will start.
    if (state === "unstarted" || state === "cued") return;
    if (pendingSeek != null) {
      if (Math.abs(secs - pendingSeek) > 1) return;
      pendingSeek = null;
    }
    setCurrentTime(secs);
    // Only once it's really playing: a player still starting up can report a
    // stale position, which would stop playback before it begins.
    if (state === "playing" && playing() && shouldStop?.(secs)) {
      player.pause();
      setPlaying(false);
    }
  };

  const player = createYouTubeController({
    host: () => host,
    onStateChange: (state) => {
      if (state === "playing") setPlaying(true);
      else if (state === "paused" || state === "ended") setPlaying(false);
    },
    onTick,
  });
  onCleanup(() => player.destroy());

  /** Plays `meeting` from `secs` until `stop` says to stop, or it's paused. */
  const play = (
    meeting: PlayableMeeting,
    secs: number,
    stop: (secs: number) => boolean,
  ) => {
    setMeetingId(meeting.id);
    // Move the highlight right away rather than on the next poll.
    setCurrentTime(secs);
    setPlaying(true);
    shouldStop = stop;
    pendingSeek = secs;
    return player.play({ videoId: meeting.youtubeId, secs });
  };

  const pause = () => {
    setPlaying(false);
    player.pause();
  };

  return {
    /** The meeting loaded into the player, or null before anything has played. */
    meetingId,
    currentTime,
    playing,
    play,
    pause,
    setHost: (el: HTMLDivElement) => (host = el),
  };
}

export type HiddenPlayer = ReturnType<typeof createHiddenPlayer>;
