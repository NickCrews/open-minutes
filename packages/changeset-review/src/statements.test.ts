import { describe, expect, test } from "vite-plus/test";
import { splitStatements } from "./statements";

describe("splitStatements", () => {
  test("splits at semicolons and keeps the comment above each statement", () => {
    const sql = `-- Reading it out: "AM one ninety-two"
SELECT om.replace_words('5', '1:40:27.97', 'a 192-2026', 'AM 192-2026');
SELECT om.replace_words('5', '1:40:15.89', 'a m 210-2026', 'AM 210-2026');
-- "One ninety" is a false start;
-- drop it.
SELECT om.relabel('5', '1:41:42.37', 'identified:zac-johnson');
`;
    expect(splitStatements(sql)).toEqual([
      {
        sql: "SELECT om.replace_words('5', '1:40:27.97', 'a 192-2026', 'AM 192-2026');",
        comment: 'Reading it out: "AM one ninety-two"',
        line: 2,
        kind: "replace_words",
        at: 6027.97,
      },
      {
        sql: "SELECT om.replace_words('5', '1:40:15.89', 'a m 210-2026', 'AM 210-2026');",
        comment: null,
        line: 3,
        kind: "replace_words",
        at: 6015.89,
      },
      {
        sql: "SELECT om.relabel('5', '1:41:42.37', 'identified:zac-johnson');",
        comment: '"One ninety" is a false start;\ndrop it.',
        line: 6,
        kind: "relabel",
        at: 6102.37,
      },
    ]);
  });

  test("ignores semicolons in strings, identifiers, comments and dollar quotes", () => {
    const sql = `SELECT om.assert(true, 'one; two');
UPDATE "odd;name" SET x = E'a\\'; b' /* c; d */ WHERE y = $q$e; f$q$;
SELECT 1 -- trailing; note
;`;
    expect(splitStatements(sql).map((s) => s.sql)).toEqual([
      "SELECT om.assert(true, 'one; two');",
      `UPDATE "odd;name" SET x = E'a\\'; b' /* c; d */ WHERE y = $q$e; f$q$;`,
      "SELECT 1 -- trailing; note\n;",
    ]);
  });

  test("gives a comment after a statement on its line to that statement", () => {
    const [first, second] = splitStatements(
      "UPDATE people SET bio = 'x' WHERE id = 1; -- the new bio\nSELECT 2;",
    );
    expect(first!.comment).toBe("the new bio");
    expect(first!.kind).toBe("UPDATE");
    expect(second!.comment).toBeNull();
  });

  test("keeps text without a final semicolon, and drops a closing comment", () => {
    expect(splitStatements("SELECT 1;\nSELECT 2\n").map((s) => s.sql)).toEqual([
      "SELECT 1;",
      "SELECT 2",
    ]);
    expect(splitStatements("SELECT 1;\n-- done\n")).toHaveLength(1);
  });
});
