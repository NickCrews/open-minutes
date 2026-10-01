import { createSignal, onCleanup } from "solid-js";
import { createYouTubePlayer, PlayerState, type YTPlayer } from "~/lib/youtube";

/** A meeting's video, as the hidden player needs to know it. */
export type PlayableMeeting = { id: number; youtubeId: string };

/**
 * An invisible YouTube player for audio-only playback of meeting excerpts, one
 * shared by every meeting on the page. Created lazily on the first play;
 * playing another meeting loads its video into the same player.
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
  let playerPromise: Promise<YTPlayer> | undefined;
  let loadedVideo: string | null = null;
  let shouldStop: ((secs: number) => boolean) | undefined;
  // The playhead position just asked for. Until the player reports reaching
  // it, polled times are the old position (or, on a fresh player, a start
  // rounded down to the second), so they neither move the highlight nor get
  // checked against `shouldStop`.
  let pendingSeek: number | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    clearInterval(poll);
    void playerPromise?.then((player) => player.destroy());
  });

  const onPoll = (player: YTPlayer) => {
    const secs = player.getCurrentTime?.();
    if (typeof secs !== "number" || Number.isNaN(secs)) return;
    if (pendingSeek != null) {
      if (Math.abs(secs - pendingSeek) > 1) return;
      pendingSeek = null;
    }
    setCurrentTime(secs);
    if (playing() && shouldStop?.(secs)) {
      player.pauseVideo();
      setPlaying(false);
    }
  };

  const createPlayer = async (videoId: string, startSecs: number) => {
    const player = await createYouTubePlayer(host!, {
      videoId,
      playerVars: { autoplay: 1, start: Math.floor(startSecs), playsinline: 1 },
      onStateChange: ({ data }) => {
        if (data === PlayerState.playing) setPlaying(true);
        else if (data === PlayerState.paused || data === PlayerState.ended)
          setPlaying(false);
      },
    });
    // `start` only takes whole seconds.
    player.seekTo(startSecs, true);
    // The IFrame API has no timeupdate event, so poll.
    poll = setInterval(() => onPoll(player), 250);
    return player;
  };

  /** Plays `meeting` from `secs` until `stop` says to stop, or it's paused. */
  const play = async (
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
    if (!playerPromise) {
      loadedVideo = meeting.youtubeId;
      playerPromise = createPlayer(meeting.youtubeId, secs);
      return;
    }
    const player = await playerPromise;
    if (disposed) return;
    if (loadedVideo === meeting.youtubeId) {
      player.seekTo(secs, true);
      player.playVideo();
    } else {
      loadedVideo = meeting.youtubeId;
      player.loadVideoById({ videoId: meeting.youtubeId, startSeconds: secs });
    }
  };

  const pause = () => {
    setPlaying(false);
    void playerPromise?.then((player) => {
      if (!playing()) player.pauseVideo();
    });
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
