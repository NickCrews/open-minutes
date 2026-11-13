import { describe, expect, test } from "vite-plus/test";
import { sqlHash } from "./build";
import { parseIssueRef } from "./github";
import {
  approvedVersion,
  summarize,
  CI_LOGIN,
  extractSql,
  type IssueComment,
  readThread,
  versionComment,
} from "./issue";

const SQL_1 = "SELECT om.assert(true, 'one');\n";
const SQL_2 = "-- ```fenced``` in a comment\nSELECT om.assert(true, 'two');\n";

let id = 0;
function comment(body: string, over: Partial<IssueComment> = {}): IssueComment {
  id++;
  return {
    id,
    html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
    body,
    user: { login: "agent" },
    author_association: "OWNER",
    created_at: `2026-11-13T00:00:0${id % 10}Z`,
    updated_at: `2026-11-13T00:00:0${id % 10}Z`,
    ...over,
  };
}

const at = (second: number) =>
  `2026-11-13T00:00:${String(second).padStart(2, "0")}Z`;
const check = (version: number, sql: string, ok = true, effect = "e") =>
  `<!-- changeset:check v${version} sha256=${sqlHash(sql)} effect=${effect.repeat(64)} ${ok ? "ok" : "fails"} -->\n### checked`;

describe("versions", () => {
  test("a version comment reads back as its SQL and note, whatever the SQL holds", () => {
    const body = versionComment(2, SQL_2, "Answers the review: fixed #3.");
    expect(body).toContain("````sql");
    expect(extractSql(body)).toBe(SQL_2);
    const thread = readThread([comment(body)], sqlHash);
    expect(thread.versions).toMatchObject([
      {
        version: 2,
        sql: SQL_2,
        sha256: sqlHash(SQL_2),
        note: "Answers the review: fixed #3.",
        author: "agent",
      },
    ]);
  });

  test("only people with write access post versions", () => {
    const thread = readThread(
      [
        comment(versionComment(1, SQL_1)),
        comment(versionComment(2, SQL_2), {
          author_association: "CONTRIBUTOR",
          user: { login: "stranger" },
        }),
        comment(versionComment(1, SQL_2)),
      ],
      sqlHash,
    );
    expect(thread.versions.map((v) => [v.version, v.sql])).toEqual([
      [1, SQL_1],
    ]);
    expect(thread.problems).toHaveLength(2);
  });

  test("only CI's checks count", () => {
    const thread = readThread(
      [
        comment(versionComment(1, SQL_1)),
        comment(check(1, SQL_1)),
        comment(check(1, SQL_1), { user: { login: CI_LOGIN } }),
      ],
      sqlHash,
    );
    expect(thread.checks).toHaveLength(1);
  });
});

describe("approvedVersion", () => {
  const v1 = comment(versionComment(1, SQL_1), {
    created_at: at(1),
    updated_at: at(1),
  });
  const v1Check = comment(check(1, SQL_1), {
    user: { login: CI_LOGIN },
    created_at: at(2),
  });
  const v2 = comment(versionComment(2, SQL_2), {
    created_at: at(3),
    updated_at: at(3),
  });
  const v2Check = comment(check(2, SQL_2), {
    user: { login: CI_LOGIN },
    created_at: at(4),
  });

  test("covers the latest version as it stood when approved", () => {
    const thread = readThread([v1, v1Check, v2, v2Check], sqlHash);
    expect(approvedVersion(thread, at(5))).toMatchObject({
      version: { version: 2, sql: SQL_2 },
      check: { effect: "e".repeat(64) },
    });
  });

  test("binds to the latest check before the approval, not a re-check after it", () => {
    const recheck = comment(check(2, SQL_2, true, "f"), {
      user: { login: CI_LOGIN },
      created_at: at(6),
    });
    const thread = readThread([v1, v1Check, v2, v2Check, recheck], sqlHash);
    expect(approvedVersion(thread, at(5))).toMatchObject({
      check: { effect: "e".repeat(64), url: v2Check.html_url },
    });
    expect(approvedVersion(thread, at(7))).toMatchObject({
      check: { effect: "f".repeat(64), url: recheck.html_url },
    });
  });

  test("refuses a version posted or edited after the approval", () => {
    const thread = readThread([v1, v1Check, v2, v2Check], sqlHash);
    expect(approvedVersion(thread, at(2))).toEqual({
      refused: "v2 was posted after the approval; review it and approve again",
    });
    const edited = readThread(
      [v1, v1Check, { ...v2, updated_at: at(9) }, v2Check],
      sqlHash,
    );
    expect(approvedVersion(edited, at(5))).toEqual({
      refused: "v2 was edited after the approval; review it and approve again",
    });
  });

  test("refuses a version CI hasn't checked as it stands, or found fails", () => {
    expect(
      approvedVersion(readThread([v1, v1Check, v2], sqlHash), at(5)),
    ).toMatchObject({ refused: expect.stringContaining("hadn't checked v2") });
    // An edit after the check changes the SQL, so the check no longer covers it.
    const v2Edited = {
      ...v2,
      body: versionComment(2, "SELECT 1;\n"),
      updated_at: at(4),
    };
    expect(
      approvedVersion(
        readThread([v1, v1Check, v2Edited, v2Check], sqlHash),
        at(5),
      ),
    ).toMatchObject({ refused: expect.stringContaining("hadn't checked v2") });
    const failing = comment(check(2, SQL_2, false), {
      user: { login: CI_LOGIN },
      created_at: at(4),
    });
    expect(
      approvedVersion(readThread([v1, v1Check, v2, failing], sqlHash), at(5)),
    ).toMatchObject({ refused: expect.stringContaining("fails") });
  });

  test("refuses a version already applied", () => {
    const applied = comment(
      `<!-- changeset:applied v2 sha256=${sqlHash(SQL_2)} -->`,
      { user: { login: CI_LOGIN } },
    );
    expect(
      approvedVersion(
        readThread([v1, v1Check, v2, v2Check, applied], sqlHash),
        at(5),
      ),
    ).toEqual({ refused: "v2 was already applied" });
  });
});

describe("parseIssueRef", () => {
  test("reads numbers, owner/name#n and URLs", () => {
    expect(parseIssueRef("12", "o/r")).toEqual({ repo: "o/r", issue: 12 });
    expect(parseIssueRef("#12", "o/r")).toEqual({ repo: "o/r", issue: 12 });
    expect(parseIssueRef("a/b#3")).toEqual({ repo: "a/b", issue: 3 });
    expect(
      parseIssueRef("https://github.com/a/b.c/issues/3#issuecomment-4"),
    ).toEqual({ repo: "a/b.c", issue: 3 });
    expect(parseIssueRef("12")).toBeNull();
    expect(parseIssueRef("changeset.sql", "o/r")).toBeNull();
  });
});

describe("summarize", () => {
  test("marks a review stale when CI's latest check found a different effect", () => {
    const sha = sqlHash(SQL_1);
    const review = (effect: string) =>
      comment(
        `<!-- changeset:review v1 sha256=${sha} effect=${effect.repeat(64)} -->\n\n\`\`\`json\n{"overall": "", "statements": []}\n\`\`\``,
      );
    const thread = readThread(
      [
        comment(versionComment(1, SQL_1)),
        comment(check(1, SQL_1, true, "e"), { user: { login: CI_LOGIN } }),
        review("e"),
        comment(check(1, SQL_1, true, "f"), { user: { login: CI_LOGIN } }),
        review("f"),
      ],
      sqlHash,
    );
    const status = summarize(
      { number: 1, title: "t", state: "open", html_url: "u", labels: [] },
      thread,
    );
    expect(status.versions[0]!.reviews.map((r) => r.stale)).toEqual([
      true,
      false,
    ]);
  });
});
