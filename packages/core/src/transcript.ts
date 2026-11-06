// The data a transcript is made of: words, grouped into segments by speaker.
// The stages that produce them are in ./transcription.

/**
 * A recognized word and the onset of its first token. The recognizer reports no
 * durations, so a word is taken to last until the next word in its speech span
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
