import { describe, expect, test } from "vite-plus/test";
import { neonBranches } from "./neon-branches";

interface FakeBranch {
  id: string;
  name: string;
  parent_id?: string;
  created_at: string;
  default?: boolean;
}

/**
 * A fake of the parts of Neon's API that neonBranches calls, holding one
 * project's branches. Every call is recorded as "METHOD /path".
 */
function fakeNeon(initial: FakeBranch[]) {
  const branches = [...initial];
  const calls: string[] = [];
  let next = 1;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2\/projects\/p1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${path}`);
    const op = [{ id: `op${next}`, status: "finished" }];
    if (method === "GET" && path === "/branches") return json({ branches });
    if (method === "POST" && path === "/branches") {
      const branch = {
        id: `br-${next++}`,
        name: body.branch.name,
        parent_id: body.branch.parent_id,
        created_at: "2026-11-15T00:00:00Z",
      };
      branches.push(branch);
      return json({ branch, operations: op });
    }
    const restore = path.match(/^\/branches\/([^/]+)\/restore$/);
    if (method === "POST" && restore) {
      if (body.preserve_under_name)
        branches.push({
          id: `br-${next++}`,
          name: body.preserve_under_name,
          parent_id: body.source_branch_id,
          created_at: "2026-11-15T00:00:00Z",
        });
      return json({ operations: op });
    }
    const one = path.match(/^\/branches\/([^/]+)$/);
    if (method === "DELETE" && one) {
      branches.splice(
        branches.findIndex((b) => b.id === one[1]),
        1,
      );
      return json({ operations: op });
    }
    if (method === "GET" && path === "/connection_uri")
      return json({
        uri: `postgresql://${url.searchParams.get("role_name")}:pw@${url.searchParams.get("branch_id")}.neon.tech/${url.searchParams.get("database_name")}?pooled=${url.searchParams.get("pooled")}`,
      });
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return {
    branches,
    calls,
    neon: neonBranches({ apiKey: "k", projectId: "p1", fetch }),
  };
}

const production: FakeBranch = {
  id: "br-main",
  name: "production",
  created_at: "2026-01-01T00:00:00Z",
  default: true,
};
const preview: FakeBranch = {
  id: "br-preview",
  name: "preview/pr-1",
  parent_id: "br-main",
  created_at: "2026-11-01T00:00:00Z",
};

describe("neonBranches", () => {
  test("branches main, or another branch", async () => {
    const { neon, branches } = fakeNeon([production, preview]);
    expect(await neon.create({ name: "agent/s1/a" })).toEqual({
      name: "agent/s1/a",
      parent: null,
      createdAt: "2026-11-15T00:00:00Z",
    });
    expect(
      await neon.create({ name: "agent/s1/b", from: "agent/s1/a" }),
    ).toMatchObject({
      parent: "agent/s1/a",
    });
    expect(branches.find((b) => b.name === "agent/s1/b")!.parent_id).toBe(
      branches.find((b) => b.name === "agent/s1/a")!.id,
    );
    await expect(neon.create({ name: "agent/s1/a" })).rejects.toThrow(
      "already exists",
    );
    await expect(neon.create({ name: "x", from: "missing" })).rejects.toThrow(
      "No branch missing",
    );
  });

  test("lists branches but not main", async () => {
    const { neon } = fakeNeon([production, preview]);
    await neon.create({ name: "agent/s1/a" });
    expect((await neon.list()).map((b) => [b.name, b.parent])).toEqual([
      ["agent/s1/a", null],
      ["preview/pr-1", null],
    ]);
    expect((await neon.list({ prefix: "agent/" })).map((b) => b.name)).toEqual([
      "agent/s1/a",
    ]);
  });

  test("gives a direct URL as the owner", async () => {
    const { neon } = fakeNeon([production, preview]);
    expect(await neon.url("preview/pr-1")).toBe(
      "postgresql://neondb_owner:pw@br-preview.neon.tech/neondb?pooled=false",
    );
  });

  test("resets a branch from its parent, deleting the old state Neon keeps", async () => {
    const { neon, branches, calls } = fakeNeon([production, preview]);
    await neon.reset("preview/pr-1");
    expect(
      calls.filter((c) => c.startsWith("POST") || c.startsWith("DELETE")),
    ).toEqual([
      "POST /branches/br-preview/restore",
      expect.stringMatching(/^DELETE \/branches\/br-\d+$/),
    ]);
    expect(branches.map((b) => b.name)).toEqual(["production", "preview/pr-1"]);
  });

  test("won't reset a branch while branches are made from it", async () => {
    const { neon } = fakeNeon([production, preview]);
    await neon.create({ name: "agent/s1/child", from: "preview/pr-1" });
    await expect(neon.reset("preview/pr-1")).rejects.toThrow(
      "remove agent/s1/child first",
    );
  });

  test("removes a branch, but never main", async () => {
    const { neon, branches } = fakeNeon([production, preview]);
    await neon.remove("preview/pr-1");
    await neon.remove("preview/pr-1");
    expect(branches.map((b) => b.name)).toEqual(["production"]);
    await expect(neon.remove("production")).rejects.toThrow(
      "Won't delete main",
    );
  });
});
