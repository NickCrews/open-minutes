import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "~/components/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "~/components/hover-card";
import { formatSecsDuration, formatTimestamp } from "~/lib/format";
import {
  type Chapter,
  chapterIndexAt,
  type ChapterSpeaker,
  chapterSpeakers,
  meetingLink,
} from "./chapters";
import { type Segment, SpeakerSwatch } from "./speaker-identity";

/** Speakers shown as swatches on a row; the rest fold into "+N". */
const TOP_SPEAKERS = 3;

/**
 * A meeting's table of contents. The chapter at the playhead is highlighted
 * and shows its bullets; the others show only their summary until opened.
 * The list follows the playhead the way the transcript does, until the reader
 * scrolls it themselves.
 */
export function ChapterList(props: {
  meetingId: number;
  chapters: Chapter[];
  segments: Segment[];
  currentTime: () => number;
  onSeek: (secs: number) => void;
}) {
  let list!: HTMLOListElement;
  const speakers = createMemo(() =>
    chapterSpeakers(props.chapters, props.segments),
  );
  const active = createMemo(() =>
    chapterIndexAt(props.chapters, props.currentTime()),
  );
  // Where the playhead sits when it's between chapters: before this row.
  const gapBefore = createMemo(() => {
    if (active() !== -1) return -1;
    const t = props.currentTime();
    const next = props.chapters.findIndex((c) => c.start > t);
    return next > 0 ? next : -1;
  });

  // Rows the reader opened or closed by hand, overriding "open when active".
  const [toggled, setToggled] = createSignal<ReadonlyMap<number, boolean>>(
    new Map(),
  );
  const isOpen = (i: number) => toggled().get(i) ?? i === active();
  const toggle = (i: number) =>
    setToggled((m) => new Map(m).set(i, !isOpen(i)));

  const [following, setFollowing] = createSignal(true);
  onMount(() => {
    const stop = () => setFollowing(false);
    list.addEventListener("wheel", stop, { passive: true });
    list.addEventListener("touchmove", stop, { passive: true });
    onCleanup(() => {
      list.removeEventListener("wheel", stop);
      list.removeEventListener("touchmove", stop);
    });
  });
  createEffect(
    on(active, (i) => {
      if (!following() || i === -1) return;
      list
        .querySelector<HTMLElement>(`[data-chapter="${i}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }),
  );

  const seek = (secs: number) => {
    setFollowing(true);
    props.onSeek(secs);
  };

  return (
    <ol ref={list} class="flex flex-col gap-1 text-sm">
      <For each={props.chapters}>
        {(chapter, i) => (
          <>
            <Show when={gapBefore() === i()}>
              <li
                aria-hidden="true"
                class="bg-primary mx-2 h-0.5 rounded-full"
                title="The playhead is between chapters"
              />
            </Show>
            <li
              data-chapter={i()}
              class="rounded-md border border-transparent px-2 py-1.5"
              classList={{
                "bg-primary/5 border-primary/20": i() === active(),
              }}
              aria-current={i() === active() ? "true" : undefined}
            >
              <div class="flex items-baseline gap-2">
                <button
                  type="button"
                  class="text-muted-foreground w-14 shrink-0 text-left text-xs tabular-nums hover:underline"
                  onClick={() => seek(chapter.start)}
                >
                  {formatTimestamp(chapter.start)}
                </button>
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left font-medium hover:underline"
                  onClick={() => seek(chapter.start)}
                >
                  {chapter.title}
                </button>
                <span class="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {formatSecsDuration(chapter.end - chapter.start, "minutes")}
                </span>
              </div>
              <p class="text-muted-foreground mt-1 pl-16">{chapter.summary}</p>
              <Show when={isOpen(i()) && chapter.bullets.length > 0}>
                <ul class="mt-1 list-disc space-y-0.5 pr-2 pl-20">
                  <For each={chapter.bullets}>{(b) => <li>{b}</li>}</For>
                </ul>
              </Show>
              <div class="mt-1 flex items-center gap-2 pl-16">
                <ChapterSpeakers speakers={speakers()[i()] ?? []} />
                <span class="flex-1" />
                <Show when={chapter.bullets.length > 0}>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-2 text-xs"
                    aria-expanded={isOpen(i())}
                    onClick={() => toggle(i())}
                  >
                    {isOpen(i()) ? "Less" : "More"}
                  </Button>
                </Show>
                <CopyLinkButton
                  url={() =>
                    meetingLink(location.origin, props.meetingId, chapter.start)
                  }
                />
              </div>
            </li>
          </>
        )}
      </For>
    </ol>
  );
}

/** The top speakers' swatches, with everyone and their time on hover. */
function ChapterSpeakers(props: { speakers: ChapterSpeaker[] }) {
  const top = () => props.speakers.slice(0, TOP_SPEAKERS);
  const rest = () => props.speakers.length - TOP_SPEAKERS;
  return (
    <Show when={props.speakers.length > 0}>
      <HoverCard>
        <HoverCardTrigger
          as="button"
          type="button"
          class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
          aria-label={`Speakers: ${props.speakers.map((s) => s.label).join(", ")}`}
        >
          <For each={top()}>
            {(s) => (
              <span class="flex min-w-0 items-center gap-1">
                <SpeakerSwatch speaker={() => s} />
                <span class="max-w-28 truncate">{s.label}</span>
              </span>
            )}
          </For>
          <Show when={rest() > 0}>
            <span class="shrink-0">+{rest()}</span>
          </Show>
        </HoverCardTrigger>
        <HoverCardPortal>
          <HoverCardContent class="w-72">
            <ul class="text-sm">
              <For each={props.speakers}>
                {(s) => (
                  <li class="flex items-baseline gap-2 py-0.5">
                    <SpeakerSwatch speaker={() => s} />
                    <span class="min-w-0 flex-1 truncate">{s.label}</span>
                    <span class="text-muted-foreground tabular-nums">
                      {formatSecsDuration(s.secs)}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCard>
    </Show>
  );
}

function CopyLinkButton(props: { url: () => string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <Button
      variant="ghost"
      size="sm"
      class="h-6 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(props.url()).then(() => {
          setCopied(true);
          clearTimeout(timer);
          timer = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied() ? "Copied" : "Copy link"}
    </Button>
  );
}
