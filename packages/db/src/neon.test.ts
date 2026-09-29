import { describe, expect, test } from "vitest";
import { directUrl } from "./cluster";
import { NeonClient, type NeonBranch, workspaceBranchName } from "./neon";

// A fake of the slice of the Neon API the client uses, recording requests.
function fakeNeon(initial: NeonBranch[]) {
  const branches = [...initial];
  const calls: string[] = [];
  const restores: { branchId: string; body: unknown }[] = [];
  let nextId = 1;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v2/projects/proj", "");
    calls.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });

    if (method === "GET" && path === "/branches") return json({ branches });
    if (method === "POST" && path === "/branches") {
      const body = JSON.parse(String(init!.body));
      const branch: NeonBranch = {
        id: `br-${nextId++}`,
        name: body.branch.name,
        parent_id: body.branch.parent_id,
        expires_at: body.branch.expires_at,
      };
      branches.push(branch);
      return json({ branch, operations: [{ id: "op-1" }] }, 201);
    }
    if (method === "GET" && path === "/operations/op-1")
      return json({ operation: { status: "finished" } });
    const dbs = /^\/branches\/([^/]+)\/databases$/.exec(path);
    if (method === "GET" && dbs)
      return json({ databases: [{ name: "neondb", owner_name: "owner" }] });
    if (method === "GET" && path === "/connection_uri") {
      const p = url.searchParams;
      const host = p.get("pooled") === "true" ? "ep-pooler" : "ep";
      return json({
        uri: `postgres://${p.get("role_name")}:pw@${host}.neon.tech/${p.get("database_name")}?branch=${p.get("branch_id")}`,
      });
    }
    const restore = /^\/branches\/([^/]+)\/restore$/.exec(path);
    if (method === "POST" && restore) {
      restores.push({
        branchId: restore[1]!,
        body: JSON.parse(String(init!.body)),
      });
      const branch = branches.find((b) => b.id === restore[1])!;
      return json({ branch, operations: [{ id: "op-1" }] });
    }
    const del = /^\/branches\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) {
      branches.splice(
        branches.findIndex((b) => b.id === del[1]),
        1,
      );
      return json({});
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return {
    branches,
    calls,
    restores,
    client: new NeonClient({ apiKey: "k", projectId: "proj", fetch: fetchFn }),
  };
}

const prod: NeonBranch = { id: "br-prod", name: "main", default: true };

describe("NeonClient", () => {
  test("creates a branch forked from the default branch, with an expiry", async () => {
    const { client, branches } = fakeNeon([prod]);
    const before = Date.now();
    const result = await client.ensureBranch("dev/feat-x", { ttlHours: 24 });

    expect(result.created).toBe(true);
    expect(result.branch.parent_id).toBe("br-prod");
    const expires = Date.parse(result.branch.expires_at!);
    expect(expires - before).toBeGreaterThanOrEqual(24 * 3_600_000 - 1000);
    expect(result.url).toBe(
      "postgres://owner:pw@ep.neon.tech/neondb?branch=br-1",
    );
    expect(result.pooledUrl).toContain("ep-pooler");
    expect(branches.map((b) => b.name)).toEqual(["main", "dev/feat-x"]);
  });

  test("reuses an existing branch instead of creating another", async () => {
    const { client, calls } = fakeNeon([
      prod,
      { id: "br-9", name: "dev/feat-x" },
    ]);
    const result = await client.ensureBranch("dev/feat-x");
    expect(result.created).toBe(false);
    expect(result.branch.id).toBe("br-9");
    expect(calls).not.toContain("POST /branches");
  });

  test("refuses to hand out or delete the production branch", async () => {
    const { client } = fakeNeon([prod]);
    await expect(client.ensureBranch("main")).rejects.toThrow(/default/);
    await expect(client.deleteBranch("main")).rejects.toThrow(/default/);
  });

  test("deletes a workspace branch, and reports a missing one", async () => {
    const { client, branches } = fakeNeon([
      prod,
      { id: "br-9", name: "dev/feat-x" },
    ]);
    expect(await client.deleteBranch("dev/feat-x")).toBe(true);
    expect(branches.map((b) => b.name)).toEqual(["main"]);
    expect(await client.deleteBranch("dev/feat-x")).toBe(false);
  });

  test("resets a workspace branch to its parent's head, keeping the branch", async () => {
    const { client, restores } = fakeNeon([
      prod,
      { id: "br-9", name: "preview/pr-7", parent_id: "br-prod" },
    ]);
    const branch = await client.resetBranch("preview/pr-7");
    expect(branch.id).toBe("br-9");
    // No timestamp or LSN: restore to the parent's current state. No
    // preserve_under_name: the diverged state isn't worth keeping.
    expect(restores).toEqual([
      { branchId: "br-9", body: { source_branch_id: "br-prod" } },
    ]);
  });

  test("refuses to reset production, and reports a missing branch", async () => {
    const { client } = fakeNeon([prod]);
    await expect(client.resetBranch("main")).rejects.toThrow(/default/);
    await expect(client.resetBranch("preview/pr-1")).rejects.toThrow(
      /No Neon branch/,
    );
  });

  test("surfaces API errors", async () => {
    const client = new NeonClient({
      apiKey: "k",
      projectId: "proj",
      fetch: (async () =>
        new Response("bad key", { status: 401 })) as typeof fetch,
    });
    await expect(client.listBranches()).rejects.toThrow(/401 bad key/);
  });
});

test("workspace branches are namespaced by git branch", () => {
  expect(workspaceBranchName("feat/x")).toBe("dev/feat/x");
});

describe("directUrl", () => {
  test("strips Neon's -pooler so locks and migrations bypass PgBouncer", () => {
    expect(
      directUrl(
        "postgres://u:p@ep-cool-sun-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toBe(
      "postgres://u:p@ep-cool-sun-123.us-east-2.aws.neon.tech/neondb?sslmode=require",
    );
  });

  test("leaves direct and non-Neon URLs alone", () => {
    const direct = "postgres://u:p@ep-cool-sun-123.us-east-2.aws.neon.tech/db";
    expect(directUrl(direct)).toBe(direct);
    const local = "postgres://u:p@localhost:5432/x-pooler";
    expect(directUrl(local)).toBe(local);
  });
});
