// The GitHub REST calls the changeset flow makes, with the token in
// $GITHUB_TOKEN or $GH_TOKEN, else `gh auth token`.

import { execFileSync } from "node:child_process";
import process from "node:process";
import type { IssueComment, IssueInfo } from "./issue";

/** An issue, by repository ("owner/name") and number. */
export interface IssueRef {
  repo: string;
  issue: number;
}

/**
 * The issue `ref` names: "123" or "#123" (in `defaultRepo`),
 * "owner/name#123", or an issue's or comment's URL. Null if it names none.
 */
export function parseIssueRef(
  ref: string,
  defaultRepo?: string,
): IssueRef | null {
  const url =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:#[\w-]*)?$/.exec(
      ref.trim(),
    );
  if (url) return { repo: url[1]!, issue: Number(url[2]) };
  const full = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  if (full) return { repo: full[1]!, issue: Number(full[2]) };
  const bare = /^#?(\d+)$/.exec(ref.trim());
  if (bare && defaultRepo) return { repo: defaultRepo, issue: Number(bare[1]) };
  return null;
}

/** "owner/name" from $GITHUB_REPOSITORY, else the `origin` remote. */
export function currentRepo(cwd?: string): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
  } catch {
    return undefined;
  }
}

function token(): string {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "No GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`",
    );
  }
}

export class GitHub {
  readonly #token = token();
  readonly #api = process.env.GITHUB_API_URL ?? "https://api.github.com";

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; next: string | null }> {
    const url = path.startsWith("http") ? path : `${this.#api}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `GitHub: ${method} ${path}: ${res.status} ${await res.text()}`,
      );
    const next =
      /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ??
      null;
    return {
      data: (res.status === 204 ? null : await res.json()) as T,
      next,
    };
  }

  async #all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let url: string | null = path; url;) {
      const page: { data: T[]; next: string | null } = await this.#request<T[]>(
        "GET",
        url,
      );
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }

  async issue({ repo, issue }: IssueRef): Promise<IssueInfo> {
    const { data } = await this.#request<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      labels: ({ name: string } | string)[];
    }>("GET", `/repos/${repo}/issues/${issue}`);
    return {
      ...data,
      labels: data.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  comments({ repo, issue }: IssueRef): Promise<IssueComment[]> {
    return this.#all(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
  }

  /** The issue's timeline events, oldest first. */
  events({ repo, issue }: IssueRef): Promise<
    {
      event: string;
      created_at: string;
      actor: { login: string } | null;
      label?: { name: string };
    }[]
  > {
    return this.#all(`/repos/${repo}/issues/${issue}/events?per_page=100`);
  }

  async createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; html_url: string }> {
    return (
      await this.#request<{ number: number; html_url: string }>(
        "POST",
        `/repos/${repo}/issues`,
        issue,
      )
    ).data;
  }

  async comment(
    { repo, issue }: IssueRef,
    body: string,
  ): Promise<{ html_url: string }> {
    return (
      await this.#request<{ html_url: string }>(
        "POST",
        `/repos/${repo}/issues/${issue}/comments`,
        { body },
      )
    ).data;
  }

  async addLabels({ repo, issue }: IssueRef, labels: string[]): Promise<void> {
    await this.#request("POST", `/repos/${repo}/issues/${issue}/labels`, {
      labels,
    });
  }

  async removeLabel({ repo, issue }: IssueRef, label: string): Promise<void> {
    try {
      await this.#request(
        "DELETE",
        `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
      );
    } catch (err) {
      // It was already gone.
      if (!String(err).includes(": 404 ")) throw err;
    }
  }

  async close({ repo, issue }: IssueRef): Promise<void> {
    await this.#request("PATCH", `/repos/${repo}/issues/${issue}`, {
      state: "closed",
      state_reason: "completed",
    });
  }

  /** A user's permission on the repository: "admin", "maintain", "write", "triage", "read" or "none". */
  async permission(repo: string, login: string): Promise<string> {
    const { data } = await this.#request<{
      role_name?: string;
      permission: string;
    }>("GET", `/repos/${repo}/collaborators/${login}/permission`);
    return data.role_name ?? data.permission;
  }
}
