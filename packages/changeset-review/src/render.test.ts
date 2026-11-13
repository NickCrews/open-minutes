import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { sqlHash } from "./build";
import { statementEffects } from "./build";
import { checkComment, sinceLast } from "./comments";
import { type Check, type IssueComment, readThread } from "./issue";
import { renderPage } from "./render";
import type { ChangesetDiff, MeetingDiff, StatementDiff } from "./types";

const CLIENT = readFileSync(new URL("./client.js", import.meta.url), "utf8");

/** client.js's reviewComment, run as the page runs it, with no document. */
const reviewComment = new Function(`${CLIENT}\nreturn reviewComment;`)() as (
  diff: unknown,
  statements: unknown[],
  review: unknown,
) => string;

function statement(over: Partial<StatementDiff>): StatementDiff {
  return {
    index: 0,
    sql: "SELECT 1;",
    comment: null,
    line: 1,
    kind: "SELECT",
    at: null,
    status: "ok",
    rows: {},
    meetings: [],
    people: [],
    ...over,
  };
}

function meetingDiff(over: Partial<MeetingDiff>): MeetingDiff {
  return {
    meeting: 5,
    changes: [],
    hunks: [],
    fields: [],
    relabelled: "",
    resolved: [],
    introduced: [],
    ...over,
  };
}

const SHA = "a".repeat(64);
const EFFECT = "e".repeat(64);
const diff: ChangesetDiff = {
  meetings: [
    { id: 5, slug: null, title: "Assembly <Regular>", date: "2026-03-24" },
    { id: 7, slug: "gbos-2026-03-23", title: "GBOS", date: "2026-03-23" },
  ],
  base: { db: "local", ranAt: "2026-11-13T00:00:00.000Z" },
  source: "https://github.com/o/r/issues/1#issuecomment-9",
  version: {
    repo: "o/r",
    issue: 1,
    version: 2,
    url: "https://github.com/o/r/issues/1#issuecomment-9",
  },
  sql: "",
  sha256: SHA,
  effect: EFFECT,
  error: null,
  statements: [
    statement({
      sql: "SELECT om.replace_words('5', '0:10:44.08', 'good wood', 'Girdwood');",
      comment: "Misheard </script> name",
      line: 2,
      kind: "replace_words",
      at: 644.08,
      rows: { segments: { updated: 1, inserted: 0, deleted: 0 } },
      meetings: [
        meetingDiff({
          changes: [
            { kind: "words", start: 644.08, old: "good wood", new: "Girdwood" },
          ],
          hunks: [
            {
              before: [
                {
                  index: 3,
                  speaker: {
                    label: "identified:kyle-kelley",
                    name: "Kyle Kelley",
                  },
                  start: 640,
                  changed: false,
                  items: [
                    { gap: 4 },
                    { text: "good", start: 644.08, mark: "del" },
                    { text: "wood", start: 644.3, mark: "del" },
                  ],
                },
              ],
              after: [
                {
                  index: 3,
                  speaker: {
                    label: "identified:kyle-kelley",
                    name: "Kyle Kelley",
                  },
                  start: 640,
                  changed: false,
                  items: [
                    { gap: 4 },
                    { text: "Girdwood", start: 644.08, mark: "ins" },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    }),
    statement({
      index: 1,
      sql: "SELECT om.assert(true, 'x');",
      kind: "assert",
      line: 3,
    }),
    statement({
      index: 2,
      sql: "SELECT om.replace_all_words('x', 'Gridwood', 'Girdwood');",
      kind: "replace_all_words",
      line: 4,
      rows: { segments: { updated: 2, inserted: 0, deleted: 0 } },
      meetings: [
        meetingDiff({
          changes: [
            { kind: "words", start: 10, old: "Gridwood", new: "Girdwood" },
          ],
        }),
        meetingDiff({
          meeting: 7,
          changes: [
            { kind: "words", start: 20, old: "Gridwood", new: "Girdwood" },
          ],
          introduced: [
            {
              code: "filler-word",
              severity: "warning",
              message: "um",
              where: "seg 1 0:00:20.00",
              start: 20,
            },
          ],
        }),
      ],
      people: [{ row: "person 3", field: "bio", old: null, new: "A <bio>." }],
    }),
  ],
  rows: { segments: { updated: 3, inserted: 0, deleted: 0 } },
  outcomes: [
    {
      meeting: 7,
      resolved: [],
      introduced: [
        {
          code: "filler-word",
          severity: "warning",
          message: "um",
          where: "seg 1 0:00:20.00",
          start: 20,
        },
      ],
    },
  ],
};

describe("renderPage", () => {
  const page = renderPage(diff, CLIENT);

  test("shows each statement's comment, words and speakers, escaped", () => {
    expect(page).toContain(
      'Changeset v2 of <a href="https://github.com/o/r/issues/1">o/r#1</a>',
    );
    expect(page).toContain("Assembly &lt;Regular&gt;");
    expect(page).toContain("Would apply.");
    expect(page).toContain(
      '<span class="w del" title="0:10:44.08">good</span>',
    );
    expect(page).toContain(
      '<span class="w ins" title="0:10:44.08">Girdwood</span>',
    );
    expect(page).toContain('<span class="speaker">Kyle Kelley</span>');
    expect(page).toContain('<span class="gap">4 words</span>');
    expect(page).toContain("The assertion holds.");
    expect(page).toContain(
      'data-summary="&quot;good wood&quot; -&gt; &quot;Girdwood&quot; at 0:10:44.08"',
    );
    // A statement that changes two meetings shows each under its name.
    expect(page).toContain(
      '<h3 class="in-meeting">In <code>gbos-2026-03-23</code></h3>',
    );
    expect(page).toContain(
      'data-summary="&quot;Gridwood&quot; -&gt; &quot;Girdwood&quot; at 0:00:10.00 in meeting 5; &quot;Gridwood&quot; -&gt; &quot;Girdwood&quot; at 0:00:20.00 in gbos-2026-03-23; person 3 bio -&gt; &quot;A &lt;bio&gt;.&quot;"',
    );
    expect(page).toContain('<td class="new">A &lt;bio&gt;.</td>');
    // A comment can't end the page's scripts early.
    expect(page.match(/<\/script>/g)).toHaveLength(2);
  });

  test("embeds the diff and a script that parses", () => {
    const json =
      /<script type="application\/json" id="changeset-diff">(.*?)<\/script>/s.exec(
        page,
      )![1]!;
    expect(JSON.parse(json)).toEqual(diff);
    const inline = /<script>([\s\S]*)<\/script>/.exec(
      page.split("</main>")[1]!,
    )![1]!;
    expect(() => new Function(inline)).not.toThrow();
  });

  test("says where a failing changeset stops", () => {
    const failed = renderPage(
      {
        ...diff,
        error: {
          statement: 1,
          message: "assertion failed: x",
          assertion: true,
        },
        statements: [
          diff.statements[0]!,
          { ...diff.statements[1]!, status: "failed" },
        ],
      },
      CLIENT,
    );
    expect(failed).toContain("Fails at #2 (line 3):");
    expect(failed).toContain('<span class="status failed">failed</span>');
  });
});

describe("reviewComment", () => {
  const statements = [
    {
      index: 0,
      line: 2,
      kind: "replace_words",
      at: "0:10:44.08",
      summary: '"good wood" -> "Girdwood" at 0:10:44.08',
      sql: "a",
    },
    { index: 1, line: 3, kind: "assert", at: "", summary: "", sql: "b" },
    {
      index: 2,
      line: 4,
      kind: "relabel",
      at: "0:11:00.00",
      summary: "x -> y",
      sql: "c",
    },
    { index: 3, line: 5, kind: "UPDATE", at: "", summary: "", sql: "d" },
  ];
  const md = reviewComment(diff, statements, {
    verdicts: { a: "reject", b: "accept", c: "accept" },
    notes: {
      a: 'It\'s "Girdwood" only\nin the title, ```not``` here.',
      c: "Checked the audio.",
    },
    overall: "Close, one fix.",
  });

  test("lists rejections, questions and notes, then the accepted", () => {
    expect(md.split("<details>")[0]).toBe(
      `<!-- changeset:review v2 sha256=${SHA} effect=${EFFECT} -->
### Review of changeset v2

Checked against \`local\` at 2026-11-13T00:00:00.000Z: 2 accepted, 1 rejected, 0 with a question, 1 not reviewed.

Close, one fix.

- **Rejected** #1, line 2, \`replace_words\`, at 0:10:44.08: "good wood" -> "Girdwood" at 0:10:44.08
  > It's "Girdwood" only
  > in the title, \`\`\`not\`\`\` here.
- **Accepted** #3, line 4, \`relabel\`, at 0:11:00.00: x -> y
  > Checked the audio.
- **Accepted** #2

`,
    );
  });

  test("reads back as the review of that version", () => {
    const comment: IssueComment = {
      id: 1,
      html_url: "https://github.com/o/r/issues/1#issuecomment-10",
      body: md,
      user: { login: "someone" },
      author_association: "NONE",
      created_at: "2026-11-13T00:00:00Z",
      updated_at: "2026-11-13T00:00:00Z",
    };
    const thread = readThread([comment], sqlHash);
    expect(thread.problems).toEqual([]);
    expect(thread.reviews).toEqual([
      {
        review: {
          version: 2,
          sha256: SHA,
          overall: "Close, one fix.",
          statements: [
            {
              statement: 1,
              line: 2,
              kind: "replace_words",
              verdict: "reject",
              note: 'It\'s "Girdwood" only\nin the title, ```not``` here.',
            },
            {
              statement: 2,
              line: 3,
              kind: "assert",
              verdict: "accept",
              note: "",
            },
            {
              statement: 3,
              line: 4,
              kind: "relabel",
              verdict: "accept",
              note: "Checked the audio.",
            },
          ],
        },
        effect: EFFECT,
        author: "someone",
        trusted: false,
        url: comment.html_url,
        createdAt: comment.created_at,
      },
    ]);
  });
});

describe("checkComment", () => {
  test("reports the result, the violations introduced and each statement", () => {
    const md = checkComment(
      { ...diff, version: diff.version! },
      { page: { url: "https://page" }, runUrl: "https://run" },
    );
    expect(md.split("\n")[0]).toBe(
      `<!-- changeset:check v2 sha256=${SHA} effect=${EFFECT} ok -->`,
    );
    expect(md).toContain(
      "### ✅ [v2](https://github.com/o/r/issues/1#issuecomment-9) would apply",
    );
    expect(md).toContain(
      "- **introduces** warning `filler-word` seg 1 0:00:20.00: um",
    );
    expect(md).toContain(
      "**[Review page](https://page)** · [run](https://run)",
    );
    expect(md).toContain(
      "| 3 | 4 | `replace_all_words` | segments 2 updated |",
    );
  });

  test("says where a failing version stops", () => {
    const md = checkComment(
      {
        ...diff,
        version: diff.version!,
        error: {
          statement: 1,
          message: "assertion failed: x",
          assertion: true,
        },
      },
      {
        page: { unattached: "GitHub said 404" },
        runUrl: "https://run",
        why: "Checked again.",
      },
    );
    expect(md.split("\n").slice(0, 4)).toEqual([
      `<!-- changeset:check v2 sha256=${SHA} effect=${EFFECT} fails -->`,
      expect.stringMatching(
        /^<!-- changeset:effects [0-9a-f]{12} [0-9a-f]{12} [0-9a-f]{12} -->$/,
      ),
      "_Checked again._",
      "",
    ]);
    expect(md).toContain("fails at #2 (line 3)");
    expect(md).toContain(
      "The diff couldn't be published on the issue (GitHub said 404), so the review page is in [the run](https://run)'s artifacts",
    );
  });
});

describe("sinceLast", () => {
  const effects = statementEffects(diff).map((e) => e.slice(0, 12));
  const last: Check = {
    version: 2,
    sha256: SHA,
    effect: EFFECT,
    statements: effects,
    ok: true,
    url: "https://last",
    createdAt: "2026-11-13T00:00:00Z",
  };
  const failure = { statement: 0, message: "x", assertion: false };

  test("says when it now fails, or now applies", () => {
    expect(sinceLast(last, { ...diff, error: failure }, effects)).toBe(
      "Applied at [the last check](https://last); fails now.",
    );
    expect(sinceLast({ ...last, ok: false }, diff, effects)).toBe(
      "Failed at [the last check](https://last); applies now.",
    );
  });

  test("says when it does the same", () => {
    expect(sinceLast(last, diff, effects)).toBe(
      "Does what it did at [the last check](https://last): production changed nothing it changes.",
    );
  });

  test("names the statements that do something different", () => {
    const now = [effects[0]!, "0".repeat(12), "1".repeat(12)];
    expect(sinceLast(last, { ...diff, effect: "f".repeat(64) }, now)).toBe(
      "Does something different from [the last check](https://last): #2, #3 now change other data. Reviews of the last check don't cover them.",
    );
  });
});
