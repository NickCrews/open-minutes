import { getRouteApi } from "@tanstack/solid-router";
import { createSignal, onCleanup } from "solid-js";
import { storedAudioUrl } from "~/lib/audio-store";
import type { AudioPlayer } from "./audio-player";
import { createStoredAudioPlayer } from "./stored-audio-player";
import { createYouTubeAudioPlayers } from "./youtube-audio-player";

/** A meeting's video, as the hidden player needs to know it. */
export type PlayableMeeting = { id: number; youtubeId: string };

/**
 * An invisible player for audio-only playback of meeting excerpts, one shared
 * by every meeting on the page.
 *
 * It plays each meeting through a player of its own, of one of two kinds, and is what the page
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
  /** Each video's player, made the first time it's needed. */
  const players = new Map<string, AudioPlayer>();
  const youtube = createYouTubeAudioPlayers({ host: () => host });

  onCleanup(() => {
    clearInterval(poll);
    for (const player of players.values()) player.destroy();
    youtube.destroy();
  });

  // Each player's own reports count only while it's the one in use.
  const reportsFor = (youtubeId: string) => ({
    onPlayingChange: (now: boolean) => {
      if (active && active === players.get(youtubeId)) setPlaying(now);
    },
  });

  /** `youtubeId`'s player: from the store where it has the audio, else YouTube. */
  const playerFor = (youtubeId: string): AudioPlayer => {
    let player = players.get(youtubeId);
    if (player) return player;
    const url = storedAudioUrl(config().objectStorePublicUrl, youtubeId);
    player = url
      ? createStoredAudioPlayer({
          ...reportsFor(youtubeId),
          url,
          onUnavailable: () => fallBack(youtubeId),
        })
      : youtube.player({ ...reportsFor(youtubeId), youtubeId });
    players.set(youtubeId, player);
    return player;
  };

  /** Swaps `youtubeId`'s player from the store for YouTube's, and carries on. */
  const fallBack = (youtubeId: string) => {
    const failed = players.get(youtubeId);
    if (!failed) return;
    const replacement = youtube.player({ ...reportsFor(youtubeId), youtubeId });
    players.set(youtubeId, replacement);
    failed.destroy();
    if (active === failed) {
      // Carry on from YouTube, if the reader is waiting on it.
      active = null;
      if (playing()) use(replacement).play(pendingSeek ?? currentTime());
    } else if (!current) {
      replacement.load();
    }
  };

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

  /** Makes `player` the one in use, pausing the one before. */
  const use = (player: AudioPlayer) => {
    if (active && active !== player) active.pause();
    active = player;
    // Neither kind of player has an event fine-grained enough to follow words by.
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
    use(playerFor(meeting.youtubeId)).play(secs);
  };

  /**
   * Gets `meeting` loading, so a first play starts sooner: an excerpt calls
   * this when it shows. Does nothing once anything has played, by when the
   * players are warm anyway.
   */
  const prepare = (meeting: PlayableMeeting) => {
    if (current) return;
    playerFor(meeting.youtubeId).load();
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
