import { describe, expect, test } from "vite-plus/test";
import { effectHash, sqlHash } from "./hash";
import {
  CI_LOGIN,
  type IssueComment,
  readThread,
  versionComment,
} from "./issue";
import {
  type Artifact,
  diffArtifactBody,
  diffArtifactName,
  parseDiffArtifact,
  reviewPage,
} from "./published";
import type { ChangesetDiff } from "./types";

const SQL = "SELECT om.assert(true, 'a `quoted` note');\n";

const diff: ChangesetDiff = (() => {
  const d: ChangesetDiff = {
    meetings: [],
    base: { db: "production", ranAt: "2026-11-13T00:00:00Z" },
    source: null,
    version: { repo: "o/r", issue: 1, version: 1, url: "https://v1" },
    sql: SQL,
    sha256: sqlHash(SQL),
    effect: "",
    error: null,
    statements: [
      {
        index: 0,
        sql: SQL.trim(),
        comment: "has ``` in it",
        line: 1,
        kind: "assert",
        at: null,
        status: "ok",
        rows: {},
        meetings: [],
        people: [],
      },
    ],
    rows: {},
    outcomes: [],
  };
  d.effect = effectHash(d);
  return d;
})();

let id = 0;
const comment = (body: string, login = "agent"): IssueComment => {
  id++;
  return {
    id,
    html_url: `https://c/${id}`,
    body,
    user: { login },
    author_association: login === CI_LOGIN ? "NONE" : "OWNER",
    created_at: `2026-11-13T00:00:0${id}Z`,
    updated_at: `2026-11-13T00:00:0${id}Z`,
  };
};

const thread = (effect = diff.effect) =>
  readThread(
    [
      comment(versionComment(1, SQL)),
      comment(
        `<!-- changeset:check v1 sha256=${diff.sha256} effect=${effect} ok -->`,
        CI_LOGIN,
      ),
    ],
    sqlHash,
  );

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  number: 1,
  name: diffArtifactName(1),
  body: diffArtifactBody(diff, "https://site/changesets/1?v=1"),
  updated_by_actor: { login: CI_LOGIN },
  ...over,
});

describe("the published diff", () => {
  test("reads back from the artifact's body, whatever its text holds", () => {
    const body = diffArtifactBody(diff, "https://site/changesets/1?v=1");
    expect(body).not.toContain("``` in it");
    expect(parseDiffArtifact(body)).toEqual(diff);
  });

  test("is shown when CI published it for the version's latest check", () => {
    const t = thread();
    expect(reviewPage(t, t.versions[0]!, artifact()).diff).toEqual(diff);
  });

  test("isn't shown when someone but CI changed it", () => {
    const t = thread();
    expect(
      reviewPage(
        t,
        t.versions[0]!,
        artifact({ updated_by_actor: { login: "x" } }),
      ).diff,
    ).toEqual({
      missing: "the diff of v1 on the issue was last changed by x, not CI",
    });
  });

  test("isn't shown when it doesn't match CI's latest check", () => {
    const t = thread("f".repeat(64));
    expect(reviewPage(t, t.versions[0]!, artifact()).diff).toMatchObject({
      missing: expect.stringContaining("doesn't match CI's latest check"),
    });
    const tampered: ChangesetDiff = {
      ...diff,
      statements: [
        {
          ...diff.statements[0]!,
          rows: { people: { updated: 9, inserted: 0, deleted: 0 } },
        },
      ],
    };
    const t2 = thread();
    expect(
      reviewPage(
        t2,
        t2.versions[0]!,
        artifact({ body: diffArtifactBody(tampered, "u") }),
      ).diff,
    ).toMatchObject({
      missing: expect.stringContaining("doesn't match CI's latest check"),
    });
  });

  test("says so when CI hasn't checked the version or published its diff", () => {
    const unchecked = readThread([comment(versionComment(1, SQL))], sqlHash);
    expect(
      reviewPage(unchecked, unchecked.versions[0]!, undefined).diff,
    ).toEqual({ missing: "CI hasn't checked v1 as it stands yet" });
    const t = thread();
    expect(reviewPage(t, t.versions[0]!, undefined).diff).toEqual({
      missing: "CI didn't publish the diff of v1 on the issue",
    });
  });
});
