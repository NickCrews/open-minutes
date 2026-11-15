import type { Branch, Branches } from "./branches";

// Branches as Neon branches, through Neon's API: copy-on-write, so making one
// takes seconds however large main is, and it works while main is in use.
// See docs/contributing/db.md#branches.

const API = "https://console.neon.tech/api/v2";

/** What `neonBranches` needs to reach a project. */
export interface NeonOptions {
  /** A Neon API key, ideally scoped to the project. */
  apiKey: string;
  projectId: string;
  /**
   * The branch that is main, by id or name. Default: the project's default
   * branch.
   */
  main?: string;
  /** The database and role a branch's URL connects with. */
  database?: string;
  role?: string;
  /** How long to wait for Neon to finish an operation. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string;
  created_at: string;
  default?: boolean;
}

interface NeonOperation {
  id: string;
  status: string;
}

/** Neon's API, for one project. */
class NeonApi {
  private readonly options: Required<
    Pick<NeonOptions, "apiKey" | "projectId" | "timeoutMs" | "fetch">
  >;

  constructor(options: NeonApi["options"]) {
    this.options = options;
  }

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T & { operations?: NeonOperation[] }> {
    const res = await this.options.fetch(
      `${API}/projects/${this.options.projectId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok)
      throw new Error(
        `Neon API ${method} ${path}: ${res.status} ${json.message ?? text}`,
      );
    return json;
  }

  /** Wait until every operation has finished, or throw if one fails. */
  async settle(operations: NeonOperation[] = []): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    for (const op of operations) {
      let status = op.status;
      while (status !== "finished" && status !== "skipped") {
        if (status === "failed" || status === "cancelled" || status === "error")
          throw new Error(`Neon operation ${op.id} ${status}`);
        if (Date.now() > deadline)
          throw new Error(`Neon operation ${op.id} still ${status}`);
        await new Promise((r) => setTimeout(r, 500));
        status = (
          await this.call<{ operation: NeonOperation }>(
            "GET",
            `/operations/${op.id}`,
          )
        ).operation.status;
      }
    }
  }

  async branches(): Promise<NeonBranch[]> {
    return (await this.call<{ branches: NeonBranch[] }>("GET", "/branches"))
      .branches;
  }
}

/**
 * Branches of a Neon project's main branch. A branch's URL connects as the
 * main branch's owner role, which Neon copies to every branch with its
 * password, so it also opens main: hand it to nothing that shouldn't.
 */
export function neonBranches({
  apiKey,
  projectId,
  main,
  database = "neondb",
  role = "neondb_owner",
  timeoutMs = 120_000,
  fetch = globalThis.fetch,
}: NeonOptions): Branches {
  const api = new NeonApi({ apiKey, projectId, timeoutMs, fetch });

  const mainOf = (all: NeonBranch[]) => {
    const found = all.find((b) =>
      main === undefined ? b.default : b.id === main || b.name === main,
    );
    if (!found) throw new Error(`No main branch ${main ?? "(default)"}`);
    return found;
  };
  const find = (all: NeonBranch[], name: string) => {
    const found = all.find((b) => b.name === name);
    if (!found) throw new Error(`No branch ${name}`);
    return found;
  };
  const describe = (b: NeonBranch, all: NeonBranch[]): Branch => {
    const parent = all.find((p) => p.id === b.parent_id);
    return {
      name: b.name,
      parent: !parent || parent.id === mainOf(all).id ? null : parent.name,
      createdAt: b.created_at,
    };
  };

  return {
    async create({ name, from }) {
      const all = await api.branches();
      if (all.some((b) => b.name === name))
        throw new Error(`Branch ${name} already exists`);
      const parent = from === undefined ? mainOf(all) : find(all, from);
      const { branch, operations } = await api.call<{ branch: NeonBranch }>(
        "POST",
        "/branches",
        {
          branch: { name, parent_id: parent.id },
          endpoints: [{ type: "read_write" }],
        },
      );
      await api.settle(operations);
      return describe(branch, [...all, branch]);
    },
    async url(name) {
      const branch = find(await api.branches(), name);
      // Direct, not through Neon's pooler, which drops session state such as
      // advisory locks between transactions.
      const params = new URLSearchParams({
        branch_id: branch.id,
        database_name: database,
        role_name: role,
        pooled: "false",
      });
      return (
        await api.call<{ uri: string }>("GET", `/connection_uri?${params}`)
      ).uri;
    },
    async reset(name) {
      const all = await api.branches();
      const branch = find(all, name);
      if (!branch.parent_id) throw new Error(`Branch ${name} has no parent`);
      // Neon resets a branch that has, or ever had, branches of its own only
      // by keeping its old state as another branch. Refuse while it has some;
      // otherwise keep the old state under a temporary name, then delete it.
      const children = all.filter((b) => b.parent_id === branch.id);
      if (children.length)
        throw new Error(
          `Can't reset ${name} while branches are made from it: remove ${children.map((b) => b.name).join(", ")} first`,
        );
      const old = `${name}-before-reset-${Date.now().toString(36)}`;
      const { operations } = await api.call<{ branch: NeonBranch }>(
        "POST",
        `/branches/${branch.id}/restore`,
        { source_branch_id: branch.parent_id, preserve_under_name: old },
      );
      await api.settle(operations);
      const kept = (await api.branches()).find((b) => b.name === old);
      if (kept) {
        const removed = await api.call("DELETE", `/branches/${kept.id}`);
        await api.settle(removed.operations);
      }
    },
    async remove(name) {
      const branch = (await api.branches()).find((b) => b.name === name);
      if (!branch) return;
      if (branch.default) throw new Error(`Won't delete main (${name})`);
      const { operations } = await api.call("DELETE", `/branches/${branch.id}`);
      await api.settle(operations);
    },
    async list({ prefix = "" } = {}) {
      const all = await api.branches();
      const mainId = mainOf(all).id;
      return all
        .filter((b) => b.id !== mainId && b.name.startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((b) => describe(b, all));
    },
  };
}
