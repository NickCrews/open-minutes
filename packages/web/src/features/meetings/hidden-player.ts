import { getRouteApi } from "@tanstack/solid-router";
import { createSignal, onCleanup } from "solid-js";
import { storedAudioUrl } from "~/lib/audio-store";
import { createYouTubePlayer, PlayerState, type YTPlayer } from "~/lib/youtube";

/** A meeting's video, as the hidden player needs to know it. */
export type PlayableMeeting = { id: number; youtubeId: string };

/**
 * An invisible player for audio-only playback of meeting excerpts, one shared
 * by every meeting on the page.
 *
 * It plays a meeting's audio from the object store (see `storedAudioUrl`)
 * where it can: a plain `<audio>` element starts in well under a second.
 * Meetings missing from the store, and browsers that can't play its WebM
 * Opus, get an invisible YouTube embed instead, which takes a few seconds to
 * create; `prepare` gets that (or the store's file) loading before the first
 * click. Playing another meeting loads it into the same element or embed.
 *
 * It polls the playhead like the meeting page's visible player does, so an
 * excerpt can highlight words as they are spoken. Each play hands over a
 * `shouldStop` check, run against the playhead on every poll, which is how an
 * excerpt stops playback where its shown segments run out.
 */
export function createHiddenPlayer() {
  const config = getRouteApi("__root__").useLoaderData();
  const [meetingId, setMeetingId] = createSignal<number | null>(null);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let host: HTMLDivElement | undefined;
  /** The meeting last asked to play, and which of the two is playing it. */
  let current: PlayableMeeting | null = null;
  let source: "audio" | "youtube" | null = null;
  let shouldStop: ((secs: number) => boolean) | undefined;
  // The playhead position just asked for. Until the player reports reaching
  // it, polled times are the old position (or, on a fresh YouTube player, a
  // start rounded down to the second), so they neither move the highlight nor
  // get checked against `shouldStop`.
  let pendingSeek: number | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  let audio: HTMLAudioElement | undefined;
  /** The video whose stored audio `audio` holds. */
  let audioVideo: string | null = null;
  /** Videos whose stored audio failed to load, so play from YouTube. */
  const notStored = new Set<string>();

  let youtube: Promise<YTPlayer> | undefined;
  let youtubePlayer: YTPlayer | undefined;
  /** The video loaded into the YouTube player. */
  let youtubeVideo: string | null = null;

  onCleanup(() => {
    disposed = true;
    clearInterval(poll);
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    void youtube?.then((player) => player.destroy());
  });

  /** The playhead, and whether it's moving, or null if there's none yet. */
  const playhead = () => {
    if (source === "audio" && audio) {
      return {
        secs: audio.currentTime,
        moving: !audio.paused && !audio.seeking,
      };
    }
    if (source === "youtube" && youtubePlayer) {
      const state = youtubePlayer.getPlayerState?.();
      // Unstarted or cued, it reports 0 rather than where it will start.
      if (state === PlayerState.unstarted || state === PlayerState.cued) {
        return null;
      }
      return {
        secs: youtubePlayer.getCurrentTime?.(),
        moving: state === PlayerState.playing,
      };
    }
    return null;
  };

  const onPoll = () => {
    const head = playhead();
    if (!head) return;
    const { secs, moving } = head;
    if (typeof secs !== "number" || Number.isNaN(secs)) return;
    if (pendingSeek != null) {
      if (Math.abs(secs - pendingSeek) > 1) return;
      pendingSeek = null;
    }
    setCurrentTime(secs);
    // Only once it's really playing: a player still starting up can report a
    // stale position, which would stop playback before it begins.
    if (moving && playing() && shouldStop?.(secs)) {
      if (source === "audio") audio?.pause();
      else youtubePlayer?.pauseVideo();
      setPlaying(false);
    }
  };
  // Neither player has an event fine-grained enough to follow words by, so
  // poll.
  const startPolling = () => (poll ??= setInterval(onPoll, 250));

  const getAudio = () => {
    if (audio) return audio;
    const el = new Audio();
    el.preload = "metadata";
    el.addEventListener("playing", () => {
      if (source === "audio") setPlaying(true);
    });
    for (const event of ["pause", "ended"]) {
      el.addEventListener(event, () => {
        if (source === "audio") setPlaying(false);
      });
    }
    // Not in the store (or not loadable): carry on from YouTube, or get it
    // ready if nothing has played yet.
    el.addEventListener("error", () => {
      if (disposed || !audioVideo) return;
      notStored.add(audioVideo);
      const failed = audioVideo;
      audioVideo = null;
      if (source === "audio" && current && playing()) {
        void playYouTube(current, pendingSeek ?? currentTime());
      } else if (!current && !youtube && host) {
        youtube = createYouTube(failed);
      }
    });
    startPolling();
    return (audio = el);
  };

  const loadAudio = (youtubeId: string, url: string) => {
    const el = getAudio();
    if (audioVideo !== youtubeId) {
      audioVideo = youtubeId;
      el.src = url;
    }
    return el;
  };

  const playAudio = (meeting: PlayableMeeting, url: string, secs: number) => {
    source = "audio";
    youtubePlayer?.pauseVideo();
    const el = loadAudio(meeting.youtubeId, url);
    // Before the metadata loads, this sets where playback will start.
    el.currentTime = secs;
    el.play().catch((error: unknown) => {
      // A failed load is the error event's to handle. This is the browser
      // refusing to play without a click, which shouldn't happen from one.
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        if (source === "audio") setPlaying(false);
      }
    });
  };

  /**
   * Creates the YouTube player with `videoId` cued. It's started with
   * `playVideo` once ready, never `autoplay`: autoplaying a newly made embed
   * can stall back to unstarted, with nothing played.
   */
  const createYouTube = async (videoId: string) => {
    youtubeVideo = videoId;
    const player = await createYouTubePlayer(host!, {
      videoId,
      playerVars: { playsinline: 1 },
      onStateChange: ({ data }) => {
        if (source !== "youtube") return;
        if (data === PlayerState.playing) setPlaying(true);
        else if (data === PlayerState.paused || data === PlayerState.ended)
          setPlaying(false);
      },
    });
    youtubePlayer = player;
    startPolling();
    return player;
  };

  const playYouTube = async (meeting: PlayableMeeting, secs: number) => {
    source = "youtube";
    audio?.pause();
    youtube ??= createYouTube(meeting.youtubeId);
    const player = await youtube;
    // Superseded while the player was still being created.
    if (disposed || current !== meeting || source !== "youtube") return;
    if (youtubeVideo === meeting.youtubeId) {
      player.seekTo(secs, true);
      player.playVideo();
    } else {
      youtubeVideo = meeting.youtubeId;
      player.loadVideoById({ videoId: meeting.youtubeId, startSeconds: secs });
    }
  };

  const audioUrl = (meeting: PlayableMeeting) =>
    notStored.has(meeting.youtubeId)
      ? null
      : storedAudioUrl(config().objectStorePublicUrl, meeting.youtubeId);

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
    current = meeting;
    shouldStop = stop;
    pendingSeek = secs;
    const url = audioUrl(meeting);
    if (url) playAudio(meeting, url, secs);
    else await playYouTube(meeting, secs);
  };

  /**
   * Gets `meeting` loading, so a first play starts sooner: an excerpt calls
   * this when it shows. Does nothing once anything has played, by when the
   * player is warm anyway.
   */
  const prepare = (meeting: PlayableMeeting) => {
    if (current || disposed) return;
    const url = audioUrl(meeting);
    if (url) loadAudio(meeting.youtubeId, url);
    else if (!youtube && host) {
      youtube = createYouTube(meeting.youtubeId);
    }
  };

  const pause = () => {
    setPlaying(false);
    if (source === "audio") audio?.pause();
    else {
      void youtube?.then((player) => {
        if (!playing()) player.pauseVideo();
      });
    }
  };

  return {
    /** The meeting loaded into the player, or null before anything has played. */
    meetingId,
    currentTime,
    playing,
    play,
    prepare,
    pause,
    setHost: (el: HTMLDivElement) => (host = el),
  };
}

export type HiddenPlayer = ReturnType<typeof createHiddenPlayer>;
