import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "vite-plus/test";
import postgres from "postgres";
import { localBranchDatabase, localBranches, type Branches } from "./branches";
import { createTestDb, ensureTestTemplate, type TestDb } from "./testing";

/** Run `fn` on a connection to `url` that is closed afterwards. */
async function withConnection<T>(
  url: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const jurisdictions = (url: string) =>
  withConnection(url, async (sql) =>
    (
      await sql<
        { slug: string }[]
      >`SELECT slug FROM jurisdictions ORDER BY slug`
    ).map((r) => r.slug),
  );

const addJurisdiction = (url: string, slug: string) =>
  withConnection(
    url,
    (sql) => sql`INSERT INTO jurisdictions (slug) VALUES (${slug})`,
  );

describe("localBranches", () => {
  let main: TestDb;
  let branches: Branches;
  let prefix: string;

  afterEach(async () => {
    for (const b of await branches.list({ prefix }))
      await branches.remove(b.name);
    await main.drop();
  });

  /** A fresh main, and branch names unique to this test. */
  async function setup() {
    await ensureTestTemplate({});
    main = await createTestDb();
    branches = localBranches({ main: main.url });
    prefix = `test-${randomBytes(4).toString("hex")}`;
    await addJurisdiction(main.url, "main-only");
  }

  test("copies main, and resets a branch to main as it is now", async () => {
    await setup();
    const name = `${prefix}/play`;
    const branch = await branches.create({ name });
    expect(branch).toMatchObject({ name, parent: null });
    const url = await branches.url(name);
    expect(await jurisdictions(url)).toEqual(["main-only"]);

    await addJurisdiction(url, "branch-only");
    await addJurisdiction(main.url, "main-later");
    expect(await jurisdictions(url)).toEqual(["branch-only", "main-only"]);
    expect(await jurisdictions(main.url)).toEqual(["main-later", "main-only"]);

    await branches.reset(name);
    expect(await jurisdictions(url)).toEqual(["main-later", "main-only"]);
    expect(await branches.list({ prefix })).toEqual([branch]);
  });

  test("copies another branch, and resets to it", async () => {
    await setup();
    const parent = `${prefix}/parent`;
    const child = `${prefix}/child`;
    await branches.create({ name: parent });
    await addJurisdiction(await branches.url(parent), "parent-only");
    await branches.create({ name: child, from: parent });
    expect(await jurisdictions(await branches.url(child))).toEqual([
      "main-only",
      "parent-only",
    ]);
    await addJurisdiction(await branches.url(parent), "parent-later");
    await branches.reset(child);
    expect(await jurisdictions(await branches.url(child))).toEqual([
      "main-only",
      "parent-later",
      "parent-only",
    ]);
    expect(
      (await branches.list({ prefix })).map((b) => [b.name, b.parent]),
    ).toEqual([
      [child, parent],
      [parent, null],
    ]);
  });

  test("leaves a branch as it was when its parent can't be copied", async () => {
    await setup();
    const name = `${prefix}/play`;
    await branches.create({ name });
    const url = await branches.url(name);
    await addJurisdiction(url, "kept");
    // Postgres can't copy a database something else is connected to, and
    // gives up after trying for about five seconds.
    await withConnection(main.url, async (sql) => {
      await sql`SELECT 1`;
      await expect(branches.reset(name)).rejects.toThrow(
        /while something else is connected to it/,
      );
    });
    expect(await jurisdictions(url)).toEqual(["kept", "main-only"]);
  }, 20_000);

  test("removes a branch, and refuses bad names, copies and duplicates", async () => {
    await setup();
    const name = `${prefix}/play`;
    await branches.create({ name });
    await expect(branches.create({ name })).rejects.toThrow("already exists");
    await expect(
      branches.create({ name: `${prefix}/other`, from: `${prefix}/missing` }),
    ).rejects.toThrow("No branch");
    expect(() => localBranchDatabase("Agent/x")).toThrow("Bad branch name");
    expect(() => localBranchDatabase("a__b")).toThrow("Bad branch name");
    await branches.remove(name);
    await branches.remove(name);
    expect(await branches.list({ prefix })).toEqual([]);
    await expect(branches.url(name)).rejects.toThrow("No branch");
  });

  test("maps names to databases one to one", () => {
    expect(localBranchDatabase("agent/a1-b2/proposal")).toBe(
      "dbranch__agent__a1_b2__proposal",
    );
    expect(localBranchDatabase("a-b")).not.toBe(localBranchDatabase("a/b"));
  });
});
