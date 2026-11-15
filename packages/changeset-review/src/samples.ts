// Made-up changesets, as ChangesetDiffs, to look at the review page with and
// without a database: `pnpm --filter @open-minutes/changeset-review samples`
// serves them (samples-serve.ts). Each is built the way buildChangesetDiff
// builds a diff, from made-up transcripts: the SQL is split with
// splitStatements, each statement edits the transcripts, and diffTranscripts
// diffs them before and after. The SQL is never run; each statement's edit
// says what running it would do.

import { formatClock } from "@open-minutes/core/clock";
import { effectHash, sqlHash } from "./hash";
import { splitStatements } from "./statements";
import type {
  ChangesetDiff,
  FieldChange,
  IssueView,
  MeetingInfo,
  MeetingOutcome,
  RowCount,
  Speaker,
  StatementDiff,
  Transcript,
} from "./types";
import { diffTranscripts } from "./words";

export interface Sample {
  /** Its URL path on the samples server. */
  name: string;
  /** What it shows, on the samples server's index. */
  description: string;
  diff: ChangesetDiff;
}

const KYLE: Speaker = { label: "identified:kyle-kelley", name: "Kyle Kelley" };
const MIKE: Speaker = {
  label: "identified:mike-edgington",
  name: "Mike Edgington",
};
const BRIANA: Speaker = {
  label: "identified:briana-sullivan",
  name: "Briana Sullivan",
};
const SPK2: Speaker = { label: "segmented:spk-2", name: null };
const SPK3: Speaker = { label: "segmented:spk-3", name: null };
const UNLABELED: Speaker = { label: "unlabeled", name: null };

/** Seconds between the onsets of a segment's words. */
const WORD_GAP = 0.4;

/** A transcript from segments of text, each word WORD_GAP after the last. */
function transcriptOf(
  segments: [start: number, speaker: Speaker, text: string][],
): Transcript {
  return {
    segments: segments.map(([start, speaker, text]) => ({
      speaker,
      words: text
        .split(/\s+/)
        .map((word, i) => ({ text: word, start: start + i * WORD_GAP })),
    })),
  };
}

const MARCH: MeetingInfo = {
  id: 12,
  slug: "gbos-2026-03-23",
  title: "Girdwood Board of Supervisors Regular Meeting",
  date: "2026-03-23",
};
const APRIL: MeetingInfo = {
  id: 13,
  slug: "gbos-2026-04-13",
  title: "Girdwood Board of Supervisors Regular Meeting",
  date: "2026-04-13",
};
const WORK_SESSION: MeetingInfo = {
  id: 14,
  slug: null,
  title: "GBOS work sesion",
  date: "2026-04-20",
};

const marchTranscript = () =>
  transcriptOf([
    [
      600,
      KYLE,
      "Good evening everyone, I'll call this meeting of the good wood Board of Supervisors to order.",
    ],
    [
      607,
      SPK2,
      "Thank you, Mister Chair. First on the agenda is the the um trails report from Gridwood Trails.",
    ],
    [
      614.5,
      SPK3,
      "We had about forty volunteers out on the Winner Creek trail this month.",
    ],
    [
      620,
      MIKE,
      "That's great news, thank you all. Yes, the budget is on page four of the packet.",
    ],
    [627, UNLABELED, "Moving on to public comment. Is there anyone online?"],
    [
      632,
      KYLE,
      "Seeing none, we'll move on. The next item is the Gridwood valley land use plan.",
    ],
  ]);

const aprilTranscript = () =>
  transcriptOf([
    [
      30,
      KYLE,
      "Welcome back. Tonight we continue the discussion of the Gridwood land use plan.",
    ],
    [
      37,
      MIKE,
      "I'd like to thank the Gridwood Trails folks for their letter of support.",
    ],
  ]);

const workSessionTranscript = () =>
  transcriptOf([
    [5, KYLE, "This is a work session, so we won't take any votes tonight."],
  ]);

/** Where a word is: its segment, and its index in the segment. */
interface WordAt {
  seg: number;
  word: number;
}

/** The onset of a word, as a changeset writes it. */
const clock = (t: Transcript, at: WordAt) =>
  formatClock(t.segments[at.seg]!.words[at.word]!.start);

/** Replace `count` words from `at` with `words`, each new word taking the onset of the old word in its place, or of the last old word. */
function replaceWords(
  t: Transcript,
  at: WordAt,
  count: number,
  words: string[],
): void {
  const seg = t.segments[at.seg]!;
  const old = seg.words.slice(at.word, at.word + count);
  seg.words.splice(
    at.word,
    count,
    ...words.map((text, i) => ({
      text,
      start: (old[i] ?? old.at(-1)!).start,
    })),
  );
}

/** Every word equal to `old`, ignoring trailing punctuation, replaced with `text`, keeping its punctuation. */
function replaceAll(t: Transcript, old: string, text: string): number {
  let n = 0;
  for (const seg of t.segments)
    for (const w of seg.words) {
      const m = /^(.*?)([.,!?]*)$/.exec(w.text)!;
      if (m[1] === old) {
        w.text = text + m[2];
        n++;
      }
    }
  return n;
}

/** Relabel a whole segment, merging it into a neighbour of the same speaker. */
function relabel(t: Transcript, seg: number, speaker: Speaker): void {
  t.segments[seg]!.speaker = speaker;
  for (let i = t.segments.length - 1; i > 0; i--) {
    const [a, b] = [t.segments[i - 1]!, t.segments[i]!];
    if (a.speaker.label === b.speaker.label) {
      a.words.push(...b.words);
      t.segments.splice(i, 1);
    }
  }
}

/** The word at `at` starts a new segment spoken by `speaker`, to the end of its segment. */
function splitSegment(t: Transcript, at: WordAt, speaker: Speaker): void {
  const seg = t.segments[at.seg]!;
  t.segments.splice(at.seg + 1, 0, {
    speaker,
    words: seg.words.splice(at.word),
  });
}

/** A violation of a meeting rule, at a word. */
function issue(
  code: string,
  message: string,
  t: Transcript,
  at: WordAt,
  severity: IssueView["severity"] = "warning",
): IssueView {
  const start = t.segments[at.seg]!.words[at.word]!.start;
  return {
    code,
    severity,
    message,
    where: `seg ${at.seg} ${formatClock(start)}`,
    start,
  };
}

const segments = (updated: number, inserted = 0, deleted = 0) => ({
  segments: { updated, inserted, deleted },
});

/** What a statement does, given the meetings' transcripts as it finds them. */
interface Step {
  /** The statement, with the comment above it. */
  sql: string;
  /** Its edits to the transcripts, by meeting id. */
  edit?: (t: Map<number, Transcript>) => void;
  rows?: Record<string, RowCount>;
  /** Meetings it changes the row of, by id. Meetings it edits are added. */
  fields?: Record<number, FieldChange[]>;
  people?: FieldChange[];
  resolved?: Record<number, IssueView[]>;
  introduced?: Record<number, IssueView[]>;
}

interface SampleSpec {
  meetings: { info: MeetingInfo; transcript: Transcript }[];
  /** Builds each statement from the transcripts as the statements before it left them. */
  steps: ((t: Map<number, Transcript>) => Step)[];
  /** The issue version, if it came from one. */
  issue?: { issue: number; version: number };
  /** The statement it fails at, and why; `statement: null` refuses it all. */
  error?: ChangesetDiff["error"];
  context?: number;
}

/** Not a real repository, so the samples link to no real issue. */
const REPO = "example/open-minutes";

function buildSample({
  meetings,
  steps,
  issue,
  error = null,
  context = 8,
}: SampleSpec): ChangesetDiff {
  const transcripts = new Map(
    meetings.map((m) => [m.info.id, structuredClone(m.transcript)]),
  );
  const built = steps.map((step) => {
    const s = step(transcripts);
    const before = structuredClone(transcripts);
    s.edit?.(transcripts);
    return { step: s, before, after: structuredClone(transcripts) };
  });
  const sql = built.map((b) => b.step.sql.trim()).join("\n\n") + "\n";
  const split = splitStatements(sql);
  if (split.length !== built.length)
    throw new Error(
      `sample has ${built.length} steps but its SQL splits into ${split.length} statements`,
    );

  const failedAt = error ? (error.statement ?? -1) : Infinity;
  const touched = new Set<number>();
  const statements = split.map((st, index): StatementDiff => {
    const base: StatementDiff = {
      index,
      sql: st.sql,
      comment: st.comment,
      line: st.line,
      kind: st.kind,
      at: st.at,
      status:
        index < failedAt ? "ok" : index === failedAt ? "failed" : "not-run",
      rows: {},
      meetings: [],
      people: [],
    };
    if (base.status !== "ok") return base;
    const { step, before, after } = built[index]!;
    const ids = new Set([
      ...Object.keys(step.fields ?? {}).map(Number),
      ...meetings
        .map((m) => m.info.id)
        .filter(
          (id) =>
            JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)),
        ),
    ]);
    base.rows = step.rows ?? {};
    base.people = step.people ?? [];
    base.meetings = [...ids]
      .sort((a, b) => a - b)
      .map((id) => {
        touched.add(id);
        const d = diffTranscripts(before.get(id)!, after.get(id)!, {
          context,
        });
        return {
          meeting: id,
          changes: d.changes,
          hunks: d.hunks,
          fields: step.fields?.[id] ?? [],
          relabelled: sqlHash(JSON.stringify(d.relabelled)),
          resolved: step.resolved?.[id] ?? [],
          introduced: step.introduced?.[id] ?? [],
        };
      });
    return base;
  });

  const rows: Record<string, RowCount> = {};
  const outcomes: MeetingOutcome[] = [];
  if (!error) {
    for (const s of statements)
      for (const [table, r] of Object.entries(s.rows)) {
        const sum = (rows[table] ??= { updated: 0, inserted: 0, deleted: 0 });
        sum.updated += r.updated;
        sum.inserted += r.inserted;
        sum.deleted += r.deleted;
      }
    for (const id of [...touched].sort((a, b) => a - b)) {
      const ms = statements.flatMap((s) =>
        s.meetings.filter((m) => m.meeting === id),
      );
      outcomes.push({
        meeting: id,
        resolved: ms.flatMap((m) => m.resolved),
        introduced: ms.flatMap((m) => m.introduced),
      });
    }
  }

  const version = issue
    ? {
        repo: REPO,
        issue: issue.issue,
        version: issue.version,
        url: `https://github.com/${REPO}/issues/${issue.issue}#issuecomment-${issue.issue}0${issue.version}`,
      }
    : null;
  const diff: ChangesetDiff = {
    meetings: meetings
      .map((m) => m.info)
      .filter((m) => touched.has(m.id))
      .sort((a, b) => a.id - b.id),
    base: { db: "sample", ranAt: "2026-11-14T18:30:00.000Z" },
    source: version ? version.url : "changesets/sample.sql",
    version,
    sql,
    sha256: sqlHash(sql),
    effect: "",
    error,
    statements,
    rows,
    outcomes,
  };
  diff.effect = effectHash(diff);
  return diff;
}

/** Every kind of statement a transcript cleanup writes, across three meetings, and it applies. */
function cleanup(): ChangesetDiff {
  const m = MARCH.slug;
  return buildSample({
    issue: { issue: 231, version: 2 },
    meetings: [
      { info: MARCH, transcript: marchTranscript() },
      { info: APRIL, transcript: aprilTranscript() },
      { info: WORK_SESSION, transcript: workSessionTranscript() },
    ],
    steps: [
      (t) => {
        const at = { seg: 0, word: 9 };
        return {
          sql: `-- Misheard "Girdwood" in the call to order.
SELECT om.replace_words('${m}', '${clock(t.get(12)!, at)}', 'good wood', 'Girdwood');`,
          edit: (t) => replaceWords(t.get(12)!, at, 2, ["Girdwood"]),
          rows: segments(1),
        };
      },
      () => ({
        sql: `-- "Gridwood" is always Girdwood: three times across both meetings.
SELECT om.assert(
  om.replace_all_words('${m}', 'Gridwood', 'Girdwood')
    + om.replace_all_words('${APRIL.slug}', 'Gridwood', 'Girdwood') = 4,
  'expected Gridwood 4 times'
);`,
        edit: (t) => {
          replaceAll(t.get(12)!, "Gridwood", "Girdwood");
          replaceAll(t.get(13)!, "Gridwood", "Girdwood");
        },
        rows: segments(4),
      }),
      (t) => {
        const at = { seg: 1, word: 9 };
        return {
          sql: `-- A stutter and a filler.
SELECT om.replace_words('${m}', '${clock(t.get(12)!, at)}', 'the the um', 'the');`,
          edit: (t) => replaceWords(t.get(12)!, at, 3, ["the"]),
          rows: segments(1),
          resolved: {
            12: [
              issue("stutter", '"the the"', t.get(12)!, at),
              issue("filler-word", "um", t.get(12)!, { seg: 1, word: 11 }),
            ],
          },
        };
      },
      (t) => {
        const at = { seg: 2, word: 0 };
        return {
          sql: `-- The diarizer split the clerk in two; spk-3 is spk-2.
SELECT om.relabel('${m}', '${clock(t.get(12)!, at)}', 'segmented:spk-2');`,
          edit: (t) => relabel(t.get(12)!, 2, SPK2),
          rows: segments(1, 0, 1),
        };
      },
      (t) => {
        const at = { seg: 2, word: 6 };
        return {
          sql: `-- Briana answers Mike about the budget.
SELECT om.split_segment('${m}', '${clock(t.get(12)!, at)}', 'Yes,', 'identified:briana-sullivan');`,
          edit: (t) => splitSegment(t.get(12)!, at, BRIANA),
          rows: segments(1, 1),
          introduced: {
            12: [
              issue(
                "split-sentence",
                '"Yes," may continue the sentence before it',
                t.get(12)!,
                at,
              ),
            ],
          },
        };
      },
      (t) => {
        const at = { seg: 4, word: 0 };
        return {
          sql: `SELECT om.relabel('${m}', '${clock(t.get(12)!, at)}', 'identified:kyle-kelley'); -- the chair opens public comment`,
          edit: (t) => relabel(t.get(12)!, 4, KYLE),
          rows: segments(1, 0, 1),
          resolved: {
            12: [
              issue(
                "unlabeled-speaker",
                "segment has no speaker",
                t.get(12)!,
                at,
                "error",
              ),
            ],
          },
        };
      },
      () => ({
        sql: `SELECT om.assert(
  (SELECT count(*) FROM segments WHERE meeting_id = om.meeting_id('${m}')) = 5,
  'five segments left'
);`,
      }),
      () => ({
        sql: `-- Typo in the title, and give it a slug.
UPDATE meetings
SET title = 'GBOS work session', slug = 'gbos-2026-04-20-work-session'
WHERE id = 14;`,
        rows: { meetings: { updated: 1, inserted: 0, deleted: 0 } },
        fields: {
          14: [
            {
              row: "meeting",
              field: "slug",
              old: null,
              new: "gbos-2026-04-20-work-session",
            },
            {
              row: "meeting",
              field: "title",
              old: "GBOS work sesion",
              new: "GBOS work session",
            },
          ],
        },
      }),
      () => ({
        sql: `UPDATE people
SET bio = 'Treasurer of the Girdwood Board of Supervisors since 2024. She <presents> the monthly budget update.'
WHERE slug = 'briana-sullivan';`,
        rows: { people: { updated: 1, inserted: 0, deleted: 0 } },
        people: [
          {
            row: "person 41",
            field: "bio",
            old: "Girdwood resident.",
            new: "Treasurer of the Girdwood Board of Supervisors since 2024. She <presents> the monthly budget update.",
          },
        ],
      }),
    ],
  });
}

/** An assertion fails at the third statement, so the last doesn't run. */
function failing(): ChangesetDiff {
  const m = MARCH.slug;
  return buildSample({
    issue: { issue: 232, version: 1 },
    meetings: [{ info: MARCH, transcript: marchTranscript() }],
    error: {
      statement: 2,
      message: "assertion failed: expected Gridwood 3 times",
      assertion: true,
    },
    steps: [
      (t) => {
        const at = { seg: 0, word: 9 };
        return {
          sql: `SELECT om.replace_words('${m}', '${clock(t.get(12)!, at)}', 'good wood', 'Girdwood');`,
          edit: (t) => replaceWords(t.get(12)!, at, 2, ["Girdwood"]),
          rows: segments(1),
        };
      },
      (t) => {
        const at = { seg: 4, word: 0 };
        return {
          sql: `SELECT om.relabel('${m}', '${clock(t.get(12)!, at)}', 'identified:kyle-kelley');`,
          edit: (t) => relabel(t.get(12)!, 4, KYLE),
          rows: segments(1, 0, 1),
        };
      },
      () => ({
        sql: `-- There are three, I think.
SELECT om.assert(om.replace_all_words('${m}', 'Gridwood', 'Girdwood') = 3, 'expected Gridwood 3 times');`,
      }),
      (t) => {
        const at = { seg: 3, word: 6 };
        return {
          sql: `SELECT om.split_segment('${m}', '${clock(t.get(12)!, at)}', 'Yes,', 'identified:briana-sullivan');`,
        };
      },
    ],
  });
}

/** Refused before any statement ran: it does something changesets may not. */
function refused(): ChangesetDiff {
  return buildSample({
    meetings: [{ info: MARCH, transcript: marchTranscript() }],
    error: {
      statement: null,
      message:
        "permission denied for table meetings: a changeset may not DELETE meetings",
      assertion: false,
    },
    steps: [
      () => ({ sql: `DELETE FROM meetings WHERE id = 12;` }),
      () => ({ sql: `SELECT om.assert(true, 'never runs');` }),
    ],
  });
}

/** A local file, not an issue, whose one statement changes nothing. */
function noop(): ChangesetDiff {
  return buildSample({
    meetings: [{ info: MARCH, transcript: marchTranscript() }],
    steps: [
      () => ({
        sql: `-- Already fixed by an earlier changeset.
SELECT om.replace_all_words('${MARCH.slug}', 'Girdwod', 'Girdwood');`,
      }),
    ],
  });
}

/** Words of made-up council speech, for long transcripts. */
const SPEECH = `so the motion before us is to approve the contract with the
contractor for the snow removal on the Alyeska Highway and the side streets
for the coming winter season and I would ask that we hear from staff first
about the cost and whether it fits within the road service area budget that
we adopted last spring`.split(/\s+/);

/** A long meeting, and a statement for every tenth segment: a page to scroll. */
function long(): ChangesetDiff {
  const speakers = [KYLE, MIKE, BRIANA, SPK2];
  const info: MeetingInfo = {
    id: 20,
    slug: "gbos-2026-05-11",
    title: "Girdwood Board of Supervisors Regular Meeting",
    date: "2026-05-11",
  };
  const transcript = transcriptOf(
    Array.from({ length: 120 }, (_, i) => {
      const n = 12 + ((i * 7) % 30);
      const text = Array.from(
        { length: n },
        (_, j) => SPEECH[(i * 5 + j) % SPEECH.length],
      ).join(" ");
      return [60 + i * 20, speakers[i % speakers.length]!, text];
    }),
  );
  const steps: SampleSpec["steps"] = [];
  for (let seg = 3; seg < 120; seg += 10) {
    const at = { seg, word: 4 };
    steps.push((t) => {
      const words = t.get(20)!.segments[seg]!.words;
      const old = words.slice(4, 6).map((w) => w.text);
      return {
        sql: `SELECT om.replace_words('${info.slug}', '${clock(t.get(20)!, at)}', '${old.join(" ")}', '${old.join(" ").toUpperCase()}');`,
        edit: (t) =>
          replaceWords(
            t.get(20)!,
            at,
            2,
            old.map((w) => w.toUpperCase()),
          ),
        rows: segments(1),
      };
    });
    if (seg % 30 === 3)
      steps.push((t) => {
        const split = { seg: seg + 1, word: 6 };
        return {
          sql: `SELECT om.split_segment('${info.slug}', '${clock(t.get(20)!, split)}', NULL, 'segmented:spk-2');`,
          edit: (t) => splitSegment(t.get(20)!, split, SPK2),
          rows: segments(1, 1),
        };
      });
  }
  return buildSample({
    issue: { issue: 240, version: 5 },
    meetings: [{ info, transcript }],
    steps,
  });
}

/** Every sample, built afresh, so edits to this file show on reload. */
export function samples(): Sample[] {
  return [
    {
      name: "cleanup",
      description:
        "Every kind of statement a cleanup writes: words, a replace across meetings, a merge, a split, relabels, assertions, a meeting's title and slug, a person's bio, and rule violations resolved and introduced. It applies.",
      diff: cleanup(),
    },
    {
      name: "failing",
      description:
        "An assertion fails at #3, so #4 doesn't run and nothing would be saved.",
      diff: failing(),
    },
    {
      name: "refused",
      description:
        "Refused as a whole before any statement ran (the error has no statement).",
      diff: refused(),
    },
    {
      name: "noop",
      description:
        "From a local file, not an issue: one statement that changes nothing.",
      diff: noop(),
    },
    {
      name: "long",
      description:
        "Sixteen statements over a 120-segment meeting, to see a long page.",
      diff: long(),
    },
  ];
}
