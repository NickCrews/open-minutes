import { onCleanup, onMount } from "solid-js";
import { createYouTubePlayer, type YTPlayer } from "~/lib/youtube";

export function VideoPlayer(props: {
  videoId: string;
  onPlayer: (player: YTPlayer) => void;
  onTime: (secs: number) => void;
  onDuration?: (secs: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}) {
  let host!: HTMLDivElement;
  onMount(() => {
    let player: YTPlayer | undefined;
    let disposed = false;
    void createYouTubePlayer(host, {
      videoId: props.videoId,
      playerVars: { playsinline: 1 },
      onStateChange: (state) => props.onPlayingChange?.(state === "playing"),
    }).then((created) => {
      if (disposed) return created.destroy();
      player = created;
      props.onPlayer(created);
    });
    // The IFrame API has no timeupdate event, so poll. This also picks up
    // the user clicking around the player's own timeline.
    const poll = setInterval(() => {
      const secs = player?.getCurrentTime?.();
      if (typeof secs === "number" && !Number.isNaN(secs)) props.onTime(secs);
      // Duration reads as 0 until metadata loads, so poll it rather than
      // reading it once on ready.
      const total = player?.getDuration?.();
      if (typeof total === "number" && total > 0) props.onDuration?.(total);
    }, 250);
    onCleanup(() => {
      disposed = true;
      clearInterval(poll);
      player?.destroy();
    });
  });
  return (
    <div
      ref={host}
      class="aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-black [&_iframe]:h-full [&_iframe]:w-full"
    />
  );
}
