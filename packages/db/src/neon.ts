import process from "node:process";

// A small client for the Neon API's branch endpoints, for giving each
// short-lived workspace (a remote agent session, a PR preview, CI) its own
// copy-on-write branch of the production database.
//
// Configuration, from the environment (or .env.local):
//   NEON_API_KEY         Required. Prefer a project-scoped key.
//   NEON_PROJECT_ID      Required.
//   NEON_PARENT_BRANCH   Branch new branches fork from. Default: the
//                        project's default branch (production).
//   NEON_DATABASE        Default: the parent's only/first database.
//   NEON_ROLE            Default: that database's owner.
//
// Branches can be created with an expiry, so an abandoned agent session's
// branch deletes itself instead of accumulating.

const API = "https://console.neon.tech/api/v2";

export interface NeonConfig {
  apiKey: string;
  projectId: string;
  parentBranch?: string;
  database?: string;
  role?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string;
  default?: boolean;
  protected?: boolean;
  expires_at?: string;
  created_at?: string;
}

export interface EnsuredNeonBranch {
  branch: NeonBranch;
  /** False when a branch of that name already existed and was reused. */
  created: boolean;
  /** Direct (unpooled) URL: suits migrations and advisory locks. */
  url: string;
  /** Pooled URL: suits the app's many short connections. */
  pooledUrl: string;
}

export function neonConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NeonConfig {
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error(
      "NEON_API_KEY and NEON_PROJECT_ID must be set (in the environment or .env.local) to manage Neon branches.",
    );
  }
  return {
    apiKey,
    projectId,
    parentBranch: env.NEON_PARENT_BRANCH || undefined,
    database: env.NEON_DATABASE || undefined,
    role: env.NEON_ROLE || undefined,
  };
}

export class NeonClient {
  constructor(private readonly config: NeonConfig) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const fetchFn = this.config.fetch ?? fetch;
    const response = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Neon API ${method} ${path} failed: ${response.status} ${text}`,
      );
    }
    return (await response.json()) as T;
  }

  private get project(): string {
    return `/projects/${encodeURIComponent(this.config.projectId)}`;
  }

  async listBranches(): Promise<NeonBranch[]> {
    const { branches } = await this.request<{ branches: NeonBranch[] }>(
      "GET",
      // The endpoint paginates; 10000 is its documented maximum page size,
      // far beyond any realistic number of branches, so one page is all.
      `${this.project}/branches?limit=10000`,
    );
    return branches;
  }

  async findBranch(name: string): Promise<NeonBranch | undefined> {
    return (await this.listBranches()).find((b) => b.name === name);
  }

  /** The parent for new branches: NEON_PARENT_BRANCH, else the default. */
  async parentBranch(): Promise<NeonBranch> {
    const branches = await this.listBranches();
    const wanted = this.config.parentBranch;
    const parent = wanted
      ? branches.find((b) => b.name === wanted || b.id === wanted)
      : branches.find((b) => b.default);
    if (!parent) {
      throw new Error(
        wanted
          ? `Neon parent branch "${wanted}" not found.`
          : "Neon project has no default branch.",
      );
    }
    return parent;
  }

  /**
   * Returns the branch named `name`, creating it (forked from the parent,
   * with a read-write compute) if it doesn't exist. Idempotent: agents and CI
   * can call it on every start.
   */
  async ensureBranch(
    name: string,
    options: { ttlHours?: number } = {},
  ): Promise<EnsuredNeonBranch> {
    let branch = await this.findBranch(name);
    let created = false;
    if (!branch) {
      const parent = await this.parentBranch();
      const expires =
        options.ttlHours && options.ttlHours > 0
          ? new Date(Date.now() + options.ttlHours * 3_600_000).toISOString()
          : undefined;
      const result = await this.request<{
        branch: NeonBranch;
        operations?: { id: string }[];
      }>("POST", `${this.project}/branches`, {
        branch: {
          name,
          parent_id: parent.id,
          ...(expires ? { expires_at: expires } : {}),
        },
        endpoints: [{ type: "read_write" }],
      });
      branch = result.branch;
      created = true;
      await this.waitForOperations(result.operations ?? []);
    }
    if (branch.default || branch.protected) {
      // Refuse to hand a production branch to a disposable workspace, even if
      // someone passes its name.
      throw new Error(
        `Neon branch "${name}" is the default or a protected branch; refusing to use it as a workspace branch.`,
      );
    }
    const [url, pooledUrl] = await Promise.all([
      this.connectionUri(branch.id, false),
      this.connectionUri(branch.id, true),
    ]);
    return { branch, created, url, pooledUrl };
  }

  async deleteBranch(name: string): Promise<boolean> {
    const branch = await this.findBranch(name);
    if (!branch) return false;
    if (branch.default || branch.protected) {
      throw new Error(
        `Refusing to delete Neon branch "${name}": it is the default or protected.`,
      );
    }
    await this.request("DELETE", `${this.project}/branches/${branch.id}`);
    return true;
  }

  /**
   * Resets a workspace branch to its parent's current state (Neon's "restore
   * from parent"), discarding everything written to it. The branch keeps its
   * id and compute endpoint, so its connection URLs (and anything configured
   * with them, like a preview Worker's secret) stay valid.
   */
  async resetBranch(name: string): Promise<NeonBranch> {
    const branch = await this.findBranch(name);
    if (!branch) throw new Error(`No Neon branch "${name}".`);
    if (branch.default || branch.protected) {
      throw new Error(
        `Refusing to reset Neon branch "${name}": it is the default or protected.`,
      );
    }
    const parentId = branch.parent_id ?? (await this.parentBranch()).id;
    const result = await this.request<{
      branch: NeonBranch;
      operations?: { id: string }[];
    }>("POST", `${this.project}/branches/${branch.id}/restore`, {
      source_branch_id: parentId,
    });
    await this.waitForOperations(result.operations ?? []);
    return result.branch;
  }

  async connectionUri(branchId: string, pooled: boolean): Promise<string> {
    let { database, role } = this.config;
    if (!database || !role) {
      const { databases } = await this.request<{
        databases: { name: string; owner_name: string }[];
      }>("GET", `${this.project}/branches/${branchId}/databases`);
      const chosen = database
        ? databases.find((d) => d.name === database)
        : databases[0];
      if (!chosen) throw new Error(`No database found on branch ${branchId}.`);
      database = chosen.name;
      role ??= chosen.owner_name;
    }
    const params = new URLSearchParams({
      branch_id: branchId,
      database_name: database,
      role_name: role,
      pooled: String(pooled),
    });
    const { uri } = await this.request<{ uri: string }>(
      "GET",
      `${this.project}/connection_uri?${params}`,
    );
    return uri;
  }

  private async waitForOperations(
    operations: { id: string }[],
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const op of operations) {
      for (;;) {
        const { operation } = await this.request<{
          operation: { status: string; error?: string };
        }>("GET", `${this.project}/operations/${op.id}`);
        if (operation.status === "finished" || operation.status === "skipped")
          break;
        if (["failed", "error", "cancelled"].includes(operation.status)) {
          throw new Error(
            `Neon operation ${op.id} ${operation.status}: ${operation.error ?? ""}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for Neon operation ${op.id}.`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * The Neon branch name for a workspace on a git branch. Agents and humans
 * share this, so re-running on the same git branch reuses the same Neon one.
 */
export function workspaceBranchName(gitBranch: string): string {
  return `dev/${gitBranch}`;
}
