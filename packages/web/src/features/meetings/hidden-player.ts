import { getRouteApi } from "@tanstack/solid-router";
import { createSignal, onCleanup } from "solid-js";
import { storedAudioUrl } from "~/lib/audio-store";
import type { AudioPlayer } from "./audio-player";
import { createStoredAudioPlayer } from "./stored-audio-player";
import { createYouTubeAudioPlayer } from "./youtube-audio-player";

/** A meeting's video, as the hidden player needs to know it. */
export type PlayableMeeting = { id: number; youtubeId: string };

/**
 * An invisible player for audio-only playback of meeting excerpts, one shared
 * by every meeting on the page.
 *
 * It plays each meeting through one of two players, and is what the page
 * sees: which meeting is playing, where, and whether it's playing.
 * - The object store's copy of the audio (`createStoredAudioPlayer`) where
 *   there is one and the browser can play it: it starts in well under a
 *   second.
 * - A hidden YouTube embed (`createYouTubeAudioPlayer`) otherwise, including
 *   when the store turns out not to have the meeting, mid-play or not.
 * `prepare` gets the right one loading before the first click.
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
  /** The meeting last asked to play, and the player playing it. */
  let current: PlayableMeeting | null = null;
  let active: AudioPlayer | null = null;
  let shouldStop: ((secs: number) => boolean) | undefined;
  // The playhead position just asked for. Until the player reports reaching
  // it, polled times are the old position, so they neither move the highlight
  // nor get checked against `shouldStop`.
  let pendingSeek: number | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  /** Videos the store turned out not to have, so they play from YouTube. */
  const notStored = new Set<string>();

  const storedUrl = (youtubeId: string) =>
    notStored.has(youtubeId)
      ? null
      : storedAudioUrl(config().objectStorePublicUrl, youtubeId);

  // Each player's own reports count only while it's the one in use.
  const stored: AudioPlayer = createStoredAudioPlayer({
    urlFor: (youtubeId) => storedUrl(youtubeId) ?? "",
    onPlayingChange: (now) => {
      if (active === stored) setPlaying(now);
    },
    onUnavailable: (youtubeId) => {
      notStored.add(youtubeId);
      if (active === stored && current?.youtubeId === youtubeId) {
        // Carry on from YouTube, if the reader is waiting on it.
        if (playing()) {
          use(youtube).play(youtubeId, pendingSeek ?? currentTime());
        }
      } else if (!current) {
        youtube.load(youtubeId);
      }
    },
  });
  const youtube: AudioPlayer = createYouTubeAudioPlayer({
    host: () => host,
    onPlayingChange: (now) => {
      if (active === youtube) setPlaying(now);
    },
  });

  onCleanup(() => {
    clearInterval(poll);
    stored.destroy();
    youtube.destroy();
  });

  const playerFor = (youtubeId: string) =>
    storedUrl(youtubeId) ? stored : youtube;

  const onPoll = () => {
    const head = active?.playhead();
    if (!head) return;
    const { secs, moving } = head;
    if (pendingSeek != null) {
      if (Math.abs(secs - pendingSeek) > 1) return;
      pendingSeek = null;
    }
    setCurrentTime(secs);
    // Only once it's really playing: a player still starting up can report a
    // stale position, which would stop playback before it begins.
    if (moving && playing() && shouldStop?.(secs)) {
      active?.pause();
      setPlaying(false);
    }
  };

  /** Makes `player` the one in use, pausing the other. */
  const use = (player: AudioPlayer) => {
    if (active && active !== player) active.pause();
    active = player;
    // Neither player has an event fine-grained enough to follow words by.
    poll ??= setInterval(onPoll, 250);
    return player;
  };

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
    current = meeting;
    shouldStop = stop;
    pendingSeek = secs;
    use(playerFor(meeting.youtubeId)).play(meeting.youtubeId, secs);
  };

  /**
   * Gets `meeting` loading, so a first play starts sooner: an excerpt calls
   * this when it shows. Does nothing once anything has played, by when the
   * players are warm anyway.
   */
  const prepare = (meeting: PlayableMeeting) => {
    if (current) return;
    playerFor(meeting.youtubeId).load(meeting.youtubeId);
  };

  const pause = () => {
    setPlaying(false);
    active?.pause();
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
