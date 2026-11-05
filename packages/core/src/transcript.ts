// The data a transcript is made of: words, grouped into segments by speaker.
// The stages that produce them are in ./transcription.

/**
 * A recognized word and the onset of its first token. The recognizer reports no
 * durations, so a word is taken to last until the next word in its speech run
 * starts, and a segment to end {@link LAST_WORD_DURATION_SEC} after its last
 * word's onset.
 */
export interface Word {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word. The SQL function `words_end_secs`
 * (packages/db/src/migrations/20260720000542_derive-segment-times-from-words)
 * uses the same value; keep the two in sync.
 */
export const LAST_WORD_DURATION_SEC = 0.5;

/**
 * A run of consecutive words spoken by one speaker, and who that speaker is, as
 * far as anyone knows. See docs/speaker-identity.md.
 *
 * `Person` is how the segment names a person: a slug in the golden transcripts,
 * a `people.id` in the database. Diarization and alignment can't know who a
 * voice is, so they produce plain `Segment`s, whose `person` is always null.
 * With neither a speaker number nor a person, the segment is unattributed and
 * may mix several voices.
 */
export interface Segment<Person = never> {
  /** Diarization's number for the speaker within this meeting. */
  speakerNumber: number | null;
  /** The person speaking, once recognized. */
  person: Person | null;
  words: Word[];
}

/** {@link speakerKey} of an unattributed segment. */
export const UNATTRIBUTED = "unattributed";

/**
 * Who spoke a segment, as a key: segments with equal keys have the same
 * speaker. A person outranks a speaker number, so a voice that diarization split
 * across several numbers is still one speaker. Unattributed segments all share
 * {@link UNATTRIBUTED}.
 */
export function speakerKey(
  segment: Pick<Segment<string | number>, "speakerNumber" | "person">,
): string {
  if (segment.person !== null) return `person:${segment.person}`;
  if (segment.speakerNumber !== null) return `number:${segment.speakerNumber}`;
  return UNATTRIBUTED;
}

/** Who a segment says is speaking: its speaker number and its person. */
export type Speaker<Person = never> = Pick<
  Segment<Person>,
  "speakerNumber" | "person"
>;

/**
 * Parse a speaker label, as the golden transcripts write one:
 *
 * - "unlabeled": neither a speaker number nor a person.
 * - "segmented:spk-<n>": speaker number n.
 * - "identified:<slug>": the known person with that slug.
 */
export function parseSpeakerLabel(label: string): Speaker<string> {
  if (label === "unlabeled") return { speakerNumber: null, person: null };
  if (label.startsWith("segmented:")) {
    const m = label.slice("segmented:".length).match(/^spk-(\d+)$/);
    if (!m)
      throw new Error(
        `Invalid segmented speaker label (expected "segmented:spk-<n>"): ${JSON.stringify(label)}`,
      );
    return { speakerNumber: Number(m[1]), person: null };
  }
  if (label.startsWith("identified:")) {
    const person = label.slice("identified:".length);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(person)) {
      throw new Error(
        `Invalid identified speaker slug (expected kebab-case, eg "identified:margaret-tyler"): ${JSON.stringify(label)}`,
      );
    }
    return { speakerNumber: null, person };
  }
  throw new Error(`Unknown speaker label: ${JSON.stringify(label)}`);
}

/**
 * The speaker label for a segment's speaker. A label holds a person or a
 * speaker number, not both, so a segment with both throws rather than lose
 * one.
 */
export function formatSpeakerLabel({
  speakerNumber,
  person,
}: Speaker<string>): string {
  if (person !== null) {
    if (speakerNumber !== null)
      throw new Error(
        `A speaker label can't hold both person ${JSON.stringify(person)} and speaker number ${speakerNumber}`,
      );
    return `identified:${person}`;
  }
  if (speakerNumber !== null) return `segmented:spk-${speakerNumber}`;
  return "unlabeled";
}
