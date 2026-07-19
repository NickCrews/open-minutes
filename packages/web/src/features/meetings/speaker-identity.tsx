import type { getMeetingById } from "./index";

type Meeting = Awaited<ReturnType<typeof getMeetingById>>;
export type Segment = Meeting["segments"][number];
type Person = NonNullable<Segment["person"]>;

/**
 * How a speaker is shown in one meeting: a display name and a color slot.
 *
 * Placeholder names and colors are assigned per meeting, in order of first
 * appearance, so they are only meaningful within the transcript that produced
 * them — the same voice is "Anonymous Beaver" in one meeting and something else
 * in the next. That is deliberate: nothing is stored, and identifying a person
 * takes effect everywhere at once.
 */
export type SpeakerIdentity = {
  /** Groups segments belonging to one speaker within this meeting. */
  key: string;
  /** The person row, if this speaker has one. Null for a bare diarization label. */
  person: Person | null;
  /** Real name if known, otherwise an "Anonymous <Animal>" placeholder. */
  label: string;
  /** Whether `label` is a placeholder rather than a name someone entered. */
  anonymous: boolean;
  /** Palette slot 1..SPEAKER_COLOR_COUNT, or null for undiarized speech. */
  colorSlot: number | null;
};

/** Segments with no person and no diarization label — speech we can't attribute. */
const UNATTRIBUTED = "unattributed";

export const SPEAKER_COLOR_COUNT = 8;

/**
 * Speakers are keyed by person when there is one, so a voice that diarization
 * split across several speaker numbers still reads as a single speaker.
 */
export function speakerKey(segment: Segment): string {
  if (segment.person) return `person:${segment.person.id}`;
  if (segment.speaker_number != null) return `number:${segment.speaker_number}`;
  return UNATTRIBUTED;
}

/**
 * Assigns every speaker in a meeting a label and a color, in order of first
 * appearance. `segments` must be in chronological order.
 *
 * Colors and animal names advance on independent counters: if they shared one,
 * named speakers would consume letters and the anonymous ones would come out as
 * Aardvark, Crocodile, Fox — which reads as a bug rather than a rule.
 */
export function assignSpeakers(
  segments: Segment[],
): Map<string, SpeakerIdentity> {
  const identities = new Map<string, SpeakerIdentity>();
  let colorsUsed = 0;
  let placeholdersUsed = 0;

  for (const segment of segments) {
    const key = speakerKey(segment);
    if (identities.has(key)) continue;

    // Undiarized speech may contain several people, so it gets neither a
    // placeholder name nor a color — either would assert a single speaker we
    // have no evidence for.
    if (key === UNATTRIBUTED) {
      identities.set(key, {
        key,
        person: null,
        label: "Unknown",
        anonymous: false,
        colorSlot: null,
      });
      continue;
    }

    const name = segment.person?.name?.trim();
    identities.set(key, {
      key,
      person: segment.person,
      label: name || anonymousName(placeholdersUsed++),
      anonymous: !name,
      // Wraps past the end of the palette. Because slots are handed out in
      // order of first appearance, two speakers sharing a color are eight
      // apart in that order, and so usually far apart in the transcript.
      colorSlot: (colorsUsed++ % SPEAKER_COLOR_COUNT) + 1,
    });
  }

  return identities;
}

/** The CSS variable holding a palette slot's color. See app.css. */
export function speakerColor(slot: number | null): string | undefined {
  return slot == null ? undefined : `var(--speaker-${slot})`;
}

/**
 * The colored dot that carries a speaker's identity.
 *
 * The color goes here rather than on the name itself: several palette slots sit
 * below 3:1 contrast on the light surface, which is fine for a mark beside text
 * but not for the text. The name always stays in ink, so color is never the only
 * thing distinguishing two speakers.
 */
export function SpeakerSwatch(props: {
  speaker: () => SpeakerIdentity | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      class="size-2 shrink-0 self-center rounded-full"
      style={{
        "background-color":
          speakerColor(props.speaker()?.colorSlot ?? null) ??
          "var(--muted-foreground)",
      }}
    />
  );
}

// Two passes through the alphabet. A meeting with more than 52 unidentified
// speakers falls back to numbering; public testimony can be long, but not that
// long.
const ANIMALS = [
  // prettier-ignore
  [
    "Aardvark", "Beaver", "Crocodile", "Dolphin", "Elephant", "Falcon",
    "Gazelle", "Heron", "Ibex", "Jaguar", "Kestrel", "Lynx", "Mongoose",
    "Narwhal", "Otter", "Pelican", "Quail", "Raccoon", "Salamander",
    "Tortoise", "Urchin", "Viper", "Walrus", "Xerus", "Yak", "Zebra",
  ],
  // prettier-ignore
  [
    "Albatross", "Bison", "Cheetah", "Dormouse", "Egret", "Ferret", "Gibbon",
    "Hedgehog", "Impala", "Jackal", "Kingfisher", "Lemur", "Marmot",
    "Nightingale", "Ocelot", "Porcupine", "Quokka", "Reindeer", "Starling",
    "Tapir", "Umbrellabird", "Vulture", "Wombat", "Xenops", "Yabby", "Zebu",
  ],
];

function anonymousName(index: number): string {
  const pass = ANIMALS[Math.floor(index / 26)];
  const animal = pass?.[index % 26];
  return animal ? `Anonymous ${animal}` : `Anonymous Speaker ${index + 1}`;
}
