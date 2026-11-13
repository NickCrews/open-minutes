import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { sqlHash } from "@open-minutes/changeset-review/hash";
import {
  type IssueComment,
  LABELS,
  readThread,
} from "@open-minutes/changeset-review/issue";
import {
  type Artifact,
  diffArtifactName,
  type ReviewPage,
  reviewPage,
} from "@open-minutes/changeset-review/published";

/**
 * A changeset issue's review page: its versions, and for one of them, CI's
 * check, the diff CI published, and its reviews. It reads the issue from
 * GitHub's API with the ISSUES_READ_TOKEN secret, which GitHub requires to
 * read an issue's artifacts, and writes nothing.
 * See packages/changeset-review/README.md.
 */
export interface ChangesetReview {
  repo: string;
  issue: {
    number: number;
    title: string;
    url: string;
    open: boolean;
    approved: boolean;
    applied: boolean;
  };
  versions: { version: number; url: string; createdAt: string }[];
  /** Null when the issue has no such version, or none. */
  page: ReviewPage | null;
}

export const fetchChangesetReview = createServerFn({ method: "GET" })
  .validator(
    z.object({
      issue: z.int().positive(),
      version: z.int().positive().optional(),
    }),
  )
  .handler(async ({ data }): Promise<ChangesetReview> => {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo)
      throw new Error("GITHUB_REPOSITORY isn't set; see wrangler.jsonc");
    const base = `/repos/${repo}/issues/${data.issue}`;
    const [issue, comments] = await Promise.all([
      github<{
        number: number;
        title: string;
        html_url: string;
        state: string;
        labels: { name: string }[];
        pull_request?: unknown;
      }>(base),
      githubAll<IssueComment>(`${base}/comments?per_page=100`),
    ]);
    const labels = issue.labels.map((l) => l.name);
    if (issue.pull_request || !labels.includes(LABELS.proposal))
      throw new Error(
        `${repo}#${data.issue} isn't an issue labelled ${LABELS.proposal}`,
      );
    const thread = readThread(comments, sqlHash);
    const version =
      data.version === undefined
        ? thread.versions.at(-1)
        : thread.versions.find((v) => v.version === data.version);
    let page: ReviewPage | null = null;
    if (version) {
      page = reviewPage(thread, version, undefined);
      // Only a checked version has a diff to show.
      if (page.check) {
        try {
          page = reviewPage(
            thread,
            version,
            await diffArtifact(base, version.version),
          );
        } catch (err) {
          page = {
            ...page,
            diff: { missing: `the issue's artifacts can't be read: ${err}` },
          };
        }
      }
    }
    return {
      repo,
      issue: {
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        open: issue.state === "open",
        approved: labels.includes(LABELS.approved),
        applied: labels.includes(LABELS.applied),
      },
      versions: thread.versions.map((v) => ({
        version: v.version,
        url: v.url,
        createdAt: v.createdAt,
      })),
      page,
    };
  });

/** The artifact holding a version's diff, with its body, if the issue has one. */
async function diffArtifact(
  base: string,
  version: number,
): Promise<Artifact | undefined> {
  const listed = await github<Artifact[]>(
    `${base}/artifacts?per_page=100`,
    ARTIFACTS_API,
  );
  const found = listed.find((a) => a.name === diffArtifactName(version));
  if (!found) return undefined;
  // A single artifact may come with its version history around it.
  const one = await github<Artifact | { artifact: Artifact }>(
    `${base}/artifacts/${found.number}`,
    ARTIFACTS_API,
  );
  return "artifact" in one ? one.artifact : one;
}

/** Issue artifacts are in the REST API from this version. */
const ARTIFACTS_API = "2026-03-10";

async function github<T>(path: string, apiVersion = "2022-11-28"): Promise<T> {
  return (await request<T>(path, apiVersion)).data;
}

async function githubAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let url: string | null = path; url;) {
    const page: { data: T[]; next: string | null } = await request<T[]>(
      url,
      "2022-11-28",
    );
    out.push(...page.data);
    url = page.next;
  }
  return out;
}

async function request<T>(
  path: string,
  apiVersion: string,
): Promise<{ data: T; next: string | null }> {
  const token = process.env.ISSUES_READ_TOKEN;
  const res = await fetch(
    /^https?:\/\//.test(path)
      ? path
      : `${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "open-minutes",
        "x-github-api-version": apiVersion,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!res.ok)
    throw new Error(
      `GitHub said ${res.status} to ${path}: ${await res.text()}`,
    );
  return {
    data: (await res.json()) as T,
    next:
      /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ??
      null,
  };
}
