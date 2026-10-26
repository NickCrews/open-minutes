// The data a transcript is made of: words, grouped into segments by speaker.
// The stages that produce them are in ./transcription.

/**
 * A recognized word and the onset of its first token. Only the onset is stored:
 * the recognizer reports no durations, so any "end" would be an estimate. Where
 * word-level ends are needed (speaker alignment), they are derived from the
 * surrounding structure — a word lasts until the next word in its speech run
 * starts, or until the run ends. Where only a segment-level end is needed, it is
 * approximated as the last word's onset plus {@link LAST_WORD_DURATION_SEC}.
 */
export interface Word {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word when approximating the segment's
 * end from word onsets alone. Mirrored in the SQL function `words_end_secs`
 * (see the drop-word-end-timestamps migration) — keep the two in sync.
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
