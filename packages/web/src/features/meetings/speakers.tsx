import { createMemo, For, Show } from "solid-js";
import { PersonHoverCard } from "~/features/people/person-hover-card";
import { formatSecsDuration, intervalToSecs } from "~/lib/format";
import {
  assignSpeakers,
  type Segment,
  type SpeakerIdentity,
  speakerKey,
  SpeakerSwatch,
} from "./speaker-identity";

type Speaker = SpeakerIdentity & { secs: number };

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
 * Total speaking time per speaker, longest first.
 *
 * Names and colors come from assignSpeakers, which orders them by first
 * appearance — so this list is deliberately not alphabetical. It is a duration
 * ranking that doubles as the transcript's color legend.
 */
function tallySpeakers(segments: Segment[]): Speaker[] {
  const identities = assignSpeakers(segments);
  const secsByKey = new Map<string, number>();
  for (const segment of segments) {
    const key = speakerKey(segment);
    secsByKey.set(key, (secsByKey.get(key) ?? 0) + segmentSecs(segment));
  }
  return [...identities.values()]
    .map((identity) => ({
      ...identity,
      secs: secsByKey.get(identity.key) ?? 0,
    }))
    .sort((a, b) => b.secs - a.secs);
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
                <SpeakerSwatch speaker={() => speaker} />
                <span class="min-w-0 flex-1 truncate">
                  <Show when={speaker.person} fallback={speaker.label}>
                    {(person) => (
                      <PersonHoverCard
                        person={person()}
                        label={speaker.label}
                      />
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
