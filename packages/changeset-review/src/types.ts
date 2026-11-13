// What a changeset does, statement by statement: the structured diff that
// buildChangesetDiff computes from a database and renderPage shows. It is
// plain JSON, so it can be written to a file and shown elsewhere.

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

/** One stretch of a meeting a statement changed, before and after it. */
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

/** A field of a meeting or of a person that a statement changed. */
export interface FieldChange {
  /** "meeting", or "person <id>". */
  row: string;
  field: string;
  old: string | null;
  new: string | null;
}

/** A meeting a changeset changes. */
export interface MeetingInfo {
  id: number;
  slug: string | null;
  title: string;
  date: string | null;
}

/** What a statement did to one meeting. */
export interface MeetingDiff {
  /** The meeting's id, in {@link ChangesetDiff.meetings}. */
  meeting: number;
  changes: Change[];
  hunks: Hunk[];
  /** Its slug and title, if the statement changed them. */
  fields: FieldChange[];
  /**
   * The SHA-256 of every word whose speaker it changed, with its onset, text
   * and old and new labels: what `changes` leaves out, how far a new speaker
   * runs.
   */
  relabelled: string;
  /** Violations of the meeting rules it resolved and introduced. */
  resolved: IssueView[];
  introduced: IssueView[];
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
  /** Each meeting it changed, in order of id. */
  meetings: MeetingDiff[];
  /** The slug, name and bio of people it changed. */
  people: FieldChange[];
}

/** The violations the whole changeset resolves and introduces in a meeting. */
export interface MeetingOutcome {
  meeting: number;
  resolved: IssueView[];
  introduced: IssueView[];
}

/** A version of a changeset proposed in a GitHub issue. */
export interface VersionRef {
  /** "owner/name". */
  repo: string;
  issue: number;
  version: number;
  /** The comment holding it. */
  url: string;
}

export interface ChangesetDiff {
  /** Every meeting a statement changed, by id. */
  meetings: MeetingInfo[];
  /** What it ran against. */
  base: {
    /** The database, as a name ("local") or host and database name. */
    db: string;
    /** When it ran, as an ISO timestamp. */
    ranAt: string;
  };
  /** Where the changeset came from: a file path, URL or issue. */
  source: string | null;
  /** The issue version it is, if it came from one. */
  version: VersionRef | null;
  sql: string;
  /** The SHA-256 of `sql`, in hex, which reviews and checks cite. */
  sha256: string;
  /**
   * The SHA-256 of what it does (build.ts's effectHash), which CI checks
   * again before applying it, so it applies only if it still does what was
   * reviewed.
   */
  effect: string;
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
   * The violations the whole changeset resolves and introduces in each
   * meeting it changes, as `pnpm changeset check` reports them; empty when it
   * fails.
   */
  outcomes: MeetingOutcome[];
}

export type Verdict = "accept" | "reject" | "question";

/** A review of one version of a changeset, as a review comment carries it. */
export interface Review {
  version: number | null;
  sha256: string;
  /** A note on the whole changeset. */
  overall: string;
  /** The statements the reviewer gave a verdict or a note, by number. */
  statements: {
    /** Its number, from 1, as the page shows it ("#3"). */
    statement: number;
    line: number;
    kind: string;
    verdict: Verdict | null;
    note: string;
  }[];
}
