import { createSignal, onCleanup, onMount } from "solid-js";

/** How far below the top of the viewport the badge reads the list, in px. */
const READ_LINE = 56;

/**
 * A floating "June 2026" pill pinned to the top of the viewport while scrolling
 * a month-grouped list, like the date scrubber in a photo library. It shows the
 * month of whatever sits just under it, and hides while the list's first month
 * header is still in view, since then the header already says the same thing.
 *
 * `container` holds the month sections, each marked with `data-month-label`.
 * Reading positions on scroll (once per frame) instead of observing
 * intersections keeps it correct across the arbitrary heights of a month.
 */
export function MonthBadge(props: {
  container: () => HTMLElement | undefined;
}) {
  const [label, setLabel] = createSignal<string>();
  // Keeps the last month on screen while the badge fades out, rather than
  // blanking it first.
  const [shown, setShown] = createSignal(false);

  onMount(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections =
        props
          .container()
          ?.querySelectorAll<HTMLElement>("[data-month-label]") ?? [];
      let current: string | undefined;
      for (const section of sections) {
        if (section.getBoundingClientRect().top > READ_LINE) break;
        current = section.dataset.monthLabel;
      }
      if (current) setLabel(current);
      setShown(!!current);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    // The list changes under a still viewport as filters narrow it, so watch
    // its size as well as the scroll position.
    const resize = new ResizeObserver(schedule);
    const container = props.container();
    if (container) resize.observe(container);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    });
  });

  return (
    <div
      aria-hidden="true"
      class="bg-background/90 pointer-events-none fixed top-3 left-1/2 z-20 -translate-x-1/2 rounded-full border px-4 py-1 text-sm font-medium shadow-md backdrop-blur transition-opacity duration-200"
      classList={{ "opacity-0": !shown(), "opacity-100": shown() }}
    >
      {label() ?? " "}
    </div>
  );
}
