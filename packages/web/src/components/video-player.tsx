import { onCleanup, onMount } from "solid-js";
import { loadYouTubeIframeApi, type YTPlayer } from "~/lib/youtube";

export function VideoPlayer(props: {
  videoId: string;
  onPlayer: (player: YTPlayer) => void;
  onTime: (secs: number) => void;
}) {
  let host!: HTMLDivElement;
  onMount(() => {
    let player: YTPlayer | undefined;
    let disposed = false;
    loadYouTubeIframeApi().then((YT) => {
      if (disposed) return;
      // The API replaces the given element with the iframe, so hand it a
      // throwaway child rather than our own div.
      const mount = document.createElement("div");
      host.appendChild(mount);
      const created: YTPlayer = new YT.Player(mount, {
        videoId: props.videoId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1 },
        events: { onReady: () => props.onPlayer(created) },
      });
      player = created;
    });
    // The IFrame API has no timeupdate event, so poll. This also picks up
    // the user clicking around the player's own timeline.
    const poll = setInterval(() => {
      const secs = player?.getCurrentTime?.();
      if (typeof secs === "number" && !Number.isNaN(secs)) props.onTime(secs);
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
