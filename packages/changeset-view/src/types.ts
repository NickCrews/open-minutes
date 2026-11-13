// What a changeset does to a meeting, statement by statement: the structured
// diff that buildChangesetDiff computes from a database and renderPage shows.
// It is plain JSON, so it can be written to a file and shown elsewhere.

/** A segment's speaker: its label, as the om functions take it, and name. */
export interface Speaker {
  /** "identified:<slug>", "person:<id>", "segmented:spk-<n>" or "unlabeled". */
  label: string;
  /** The person's name, when the segment names a person who has one. */
  name: string | null;
}

/** A transcript, as the diff compares two of them. */
export interface Transcript {
  segments: { speaker: Speaker; words: { text: string; start: number }[] }[];
}

/** A word of a hunk, marked if the statement deleted or inserted it. */
export interface WordView {
  text: string;
  /** Its onset, in seconds. */
  start: number;
  mark: "del" | "ins" | null;
}

/** Words left out of a hunk, too far from what changed. */
export interface Gap {
  gap: number;
}

/** A segment, or the part of one near what changed. */
export interface SegmentView {
  /** Its index in the meeting, before or after the statement. */
  index: number;
  speaker: Speaker;
  /** The onset of its first word, in seconds. */
  start: number;
  /**
   * Whether the segment starts here with this speaker only on this side: the
   * statement split, merged or relabelled it.
   */
  changed: boolean;
  items: (WordView | Gap)[];
}

/** One stretch of the meeting a statement changed, before and after it. */
export interface Hunk {
  before: SegmentView[];
  after: SegmentView[];
}

/**
 * One change a statement made, at an onset: words replaced (either side may
 * be empty), the speaker changed from that word on, or a segment of the same
 * speaker starting (`split`) or ending there.
 */
export type Change =
  | { kind: "words"; start: number; old: string; new: string }
  | { kind: "speaker"; start: number; old: string; new: string }
  | { kind: "boundary"; start: number; split: boolean };

/** Rows changed in a table. */
export interface RowCount {
  updated: number;
  inserted: number;
  deleted: number;
}

/** A rule violation, where it is in the meeting. */
export interface IssueView {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** Where, as `pnpm transcript check` prints it: "seg 12 0:03:04.50". */
  where: string;
  /** The onset it is at, in seconds; null for the meeting or a chapter. */
  start: number | null;
}

/** A field of the meeting or of a person that a statement changed. */
export interface FieldChange {
  /** "meeting", or "person <id>". */
  row: string;
  field: string;
  old: string | null;
  new: string | null;
}

export interface StatementDiff {
  index: number;
  /** The statement's SQL, without the comment above it. */
  sql: string;
  /** The comment written above it, without the comment markers. */
  comment: string | null;
  /** The line of the changeset its SQL starts on, from 1. */
  line: number;
  /** The om function it calls ("replace_words", "assert", ...), else its first keyword ("UPDATE"). */
  kind: string;
  /** The first onset among its string arguments, in seconds. */
  at: number | null;
  /** "failed": the changeset stopped here. "not-run": an earlier one failed. */
  status: "ok" | "failed" | "not-run";
  /** Rows it changed, by table. */
  rows: Record<string, RowCount>;
  changes: Change[];
  hunks: Hunk[];
  fields: FieldChange[];
  /** Violations of the meeting rules it resolved and introduced. */
  resolved: IssueView[];
  introduced: IssueView[];
}

export interface ChangesetDiff {
  meeting: {
    id: number;
    slug: string | null;
    title: string;
    date: string | null;
  };
  /** What it ran against. */
  base: {
    /** The database, as a name ("local") or host and database name. */
    db: string;
    /** When it ran, as an ISO timestamp. */
    ranAt: string;
  };
  /** Where the changeset came from: a file path or URL. */
  source: string | null;
  sql: string;
  /** Null when every statement ran. */
  error: {
    /** The index of the statement that failed; null if the whole changeset was refused. */
    statement: number | null;
    message: string;
    assertion: boolean;
  } | null;
  statements: StatementDiff[];
  /** Rows the whole changeset changed, net, by table. */
  rows: Record<string, RowCount>;
  /**
   * Violations the whole changeset resolved and introduced, as `pnpm
   * changeset check` reports them; empty when it failed.
   */
  resolved: IssueView[];
  introduced: IssueView[];
}
