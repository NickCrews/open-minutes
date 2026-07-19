import { Link } from "@tanstack/solid-router";
import { createMemo, For, Show } from "solid-js";
import { formatSecsDuration, intervalToSecs } from "~/lib/format";
import type { Segment } from "./transcript";

type Speaker = {
  /** Stable grouping key: an identified person, a diarized number, or neither. */
  key: string;
  person: NonNullable<Segment["person"]> | null;
  speakerNumber: number | null;
  secs: number;
};

/** How long a segment lasts, falling back to its word timestamps. */
function segmentSecs(segment: Segment): number {
  const fromInterval = segment.duration_secs
    ? intervalToSecs(segment.duration_secs)
    : null;
  if (fromInterval != null) return fromInterval;
  const words = segment.words;
  if (words.length === 0) return 0;
  return Math.max(0, words[words.length - 1]!.end - words[0]!.start);
}

/**
 * Total speaking time per speaker, longest first. Segments with a person are
 * grouped by person even if they carry different diarization numbers.
 */
function tallySpeakers(segments: Segment[]): Speaker[] {
  const bySpeaker = new Map<string, Speaker>();
  for (const segment of segments) {
    const key = segment.person
      ? `person:${segment.person.id}`
      : segment.speaker_number != null
        ? `number:${segment.speaker_number}`
        : "unknown";
    let speaker = bySpeaker.get(key);
    if (!speaker) {
      speaker = {
        key,
        person: segment.person,
        speakerNumber: segment.speaker_number,
        secs: 0,
      };
      bySpeaker.set(key, speaker);
    }
    speaker.secs += segmentSecs(segment);
  }
  return [...bySpeaker.values()].sort((a, b) => b.secs - a.secs);
}

export function Speakers(props: { segments: Segment[] }) {
  const speakers = createMemo(() => tallySpeakers(props.segments));
  const total = createMemo(() =>
    speakers().reduce((sum, speaker) => sum + speaker.secs, 0),
  );
  const share = (secs: number) => (total() > 0 ? secs / total() : 0);

  return (
    <Show when={speakers().length > 0}>
      <section class="flex min-h-0 shrink-0 flex-col gap-2">
        <h2 class="text-sm font-semibold">Speakers</h2>
        <ul class="max-h-48 overflow-y-auto text-sm">
          <For each={speakers()}>
            {(speaker) => (
              <li class="flex items-baseline gap-2 py-1">
                <span class="min-w-0 flex-1 truncate">
                  <Show
                    when={speaker.person}
                    fallback={
                      speaker.speakerNumber != null
                        ? `Speaker ${speaker.speakerNumber}`
                        : "Unknown"
                    }
                  >
                    {(person) => (
                      <Link
                        to="/people/$id"
                        params={{ id: String(person().id) }}
                        class="hover:underline"
                      >
                        {person().name || "(unnamed)"}
                      </Link>
                    )}
                  </Show>
                </span>
                <span
                  class="bg-muted h-1.5 w-24 shrink-0 self-center rounded-full"
                  aria-hidden="true"
                >
                  <span
                    class="bg-primary/60 block h-full rounded-full"
                    style={{ width: `${share(speaker.secs) * 100}%` }}
                  />
                </span>
                <span class="text-muted-foreground w-20 shrink-0 text-right tabular-nums">
                  {formatSecsDuration(speaker.secs)}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
