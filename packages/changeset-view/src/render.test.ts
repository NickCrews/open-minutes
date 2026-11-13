import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { renderPage } from "./render";
import type { ChangesetDiff, StatementDiff } from "./types";

const CLIENT = readFileSync(new URL("./client.js", import.meta.url), "utf8");

/** client.js's reviewMarkdown, run as the page runs it, with no document. */
const reviewMarkdown = new Function(`${CLIENT}\nreturn reviewMarkdown;`)() as (
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
    changes: [],
    hunks: [],
    fields: [],
    resolved: [],
    introduced: [],
    ...over,
  };
}

const diff: ChangesetDiff = {
  meeting: {
    id: 5,
    slug: null,
    title: "Assembly <Regular>",
    date: "2026-03-24",
  },
  base: { db: "local", ranAt: "2026-11-13T00:00:00.000Z" },
  source: "https://github.com/o/r/issues/1",
  sql: "",
  error: null,
  statements: [
    statement({
      sql: "SELECT om.replace_words('5', '0:10:44.08', 'good wood', 'Girdwood');",
      comment: "Misheard </script> name",
      line: 2,
      kind: "replace_words",
      at: 644.08,
      rows: { segments: { updated: 1, inserted: 0, deleted: 0 } },
      changes: [
        { kind: "words", start: 644.08, old: "good wood", new: "Girdwood" },
      ],
      hunks: [
        {
          before: [
            {
              index: 3,
              speaker: { label: "identified:kyle-kelley", name: "Kyle Kelley" },
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
              speaker: { label: "identified:kyle-kelley", name: "Kyle Kelley" },
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
    statement({
      index: 1,
      sql: "SELECT om.assert(true, 'x');",
      kind: "assert",
      line: 3,
    }),
  ],
  rows: { segments: { updated: 1, inserted: 0, deleted: 0 } },
  resolved: [],
  introduced: [],
};

describe("renderPage", () => {
  const page = renderPage(diff, CLIENT);

  test("shows each statement's comment, words and speakers, escaped", () => {
    expect(page).toContain("Changeset for Assembly &lt;Regular&gt;");
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

describe("reviewMarkdown", () => {
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

  test("lists rejections, questions and notes, then the accepted", () => {
    const md = reviewMarkdown(diff, statements, {
      verdicts: { a: "reject", b: "accept", c: "accept" },
      notes: {
        a: 'It\'s "Girdwood" only\nin the title.',
        c: "Checked the audio.",
      },
      overall: "Close, one fix.",
    });
    expect(md).toBe(
      `Review of the changeset for meeting \`5\` (Assembly <Regular>), checked against \`local\` at 2026-11-13T00:00:00.000Z from https://github.com/o/r/issues/1: 2 accepted, 1 rejected, 0 with a question, 1 not reviewed.

Close, one fix.

- **Rejected** #1, line 2, \`replace_words\`, at 0:10:44.08: "good wood" -> "Girdwood" at 0:10:44.08
  > It's "Girdwood" only
  > in the title.
- **Accepted** #3, line 4, \`relabel\`, at 0:11:00.00: x -> y
  > Checked the audio.
- **Accepted** #2
`,
    );
  });
});
