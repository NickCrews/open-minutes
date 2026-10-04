import { onCleanup, onMount } from "solid-js";
import { createYouTubeController, type YouTubeController } from "~/lib/youtube";

/**
 * The meeting page's video: a {@link createYouTubeController} in a visible
 * host. `onPlayer` hands over the controller once the video is ready to play.
 */
export function VideoPlayer(props: {
  videoId: string;
  onPlayer: (player: YouTubeController) => void;
  onTime: (secs: number) => void;
  onDuration?: (secs: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}) {
  let host!: HTMLDivElement;
  onMount(() => {
    const player = createYouTubeController({
      host: () => host,
      onStateChange: (state) => props.onPlayingChange?.(state === "playing"),
      onTick: ({ secs, duration }) => {
        props.onTime(secs);
        // Duration reads as 0 until metadata loads, so it's polled rather
        // than read once on ready.
        if (duration > 0) props.onDuration?.(duration);
      },
    });
    void player.load(props.videoId).then((ready) => {
      if (ready) props.onPlayer(player);
    });
    onCleanup(() => player.destroy());
  });
  return (
    <div
      ref={host}
      class="aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-black [&_iframe]:h-full [&_iframe]:w-full"
    />
  );
}
