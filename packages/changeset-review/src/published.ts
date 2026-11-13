// The diff CI publishes for each version of a changeset issue, as an issue
// artifact, and how the website finds and checks it to show the review page.
// Pure, so the website can use it.

import { effectHash } from "./hash";
import {
  type Check,
  CI_LOGIN,
  checkOf,
  type PostedReview,
  type Thread,
  type Version,
} from "./issue";
import type { ChangesetDiff } from "./types";

/** The name of the artifact holding version `version`'s diff. */
export function diffArtifactName(version: number): string {
  return `Changeset v${version} diff`;
}

/**
 * A diff as an artifact's Markdown body: a line saying what it is, and the
 * diff as JSON in a ```json block, with backticks escaped so the block holds.
 */
export function diffArtifactBody(
  diff: ChangesetDiff,
  reviewUrl: string,
): string {
  const json = JSON.stringify(diff).replaceAll("`", "\\u0060");
  return `What CI's check found this version does, as JSON, for [the review page](${reviewUrl}).\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** The diff in an artifact's body, or null if it has none. */
export function parseDiffArtifact(body: string): ChangesetDiff | null {
  const block = /^```json\n(.*)\n```$/m.exec(body);
  if (!block) return null;
  try {
    const diff = JSON.parse(block[1]!) as ChangesetDiff;
    return Array.isArray(diff.statements) ? diff : null;
  } catch {
    return null;
  }
}

/** An issue artifact, as GitHub's REST API gives it. */
export interface Artifact {
  number: number;
  name: string;
  body: string;
  updated_by_actor?: { login: string } | null;
  creator?: { login: string } | null;
}

/** What the review page shows for one version of a changeset issue. */
export interface ReviewPage {
  version: Version;
  /** CI's latest check of it as it stands, if any. */
  check: Check | null;
  /** The diff CI published with that check, or why there's none to show. */
  diff: ChangesetDiff | { missing: string };
  /** Reviews of this version's SQL, each marked stale if it saw another effect. */
  reviews: (PostedReview & { stale: boolean })[];
}

/**
 * The review page for `version` of a thread, given the artifact named
 * {@link diffArtifactName}, if the issue has one. The diff counts only if
 * CI wrote the artifact, and it is the diff of the version's SQL with the
 * effect of CI's latest check of it.
 */
export function reviewPage(
  thread: Thread,
  version: Version,
  artifact: Artifact | undefined,
): ReviewPage {
  const check = checkOf(thread, version) ?? null;
  const reviews = thread.reviews
    .filter((r) => r.review.sha256 === version.sha256)
    .map((r) => ({
      ...r,
      stale:
        r.effect !== null && check?.effect != null && r.effect !== check.effect,
    }));
  return {
    version,
    check,
    diff: checkedDiff(version, check, artifact),
    reviews,
  };
}

function checkedDiff(
  version: Version,
  check: Check | null,
  artifact: Artifact | undefined,
): ChangesetDiff | { missing: string } {
  const v = `v${version.version}`;
  if (!check) return { missing: `CI hasn't checked ${v} as it stands yet` };
  if (!artifact)
    return { missing: `CI didn't publish the diff of ${v} on the issue` };
  const by = artifact.updated_by_actor?.login ?? artifact.creator?.login;
  if (by !== CI_LOGIN)
    return {
      missing: `the diff of ${v} on the issue was last changed by ${by ?? "someone"}, not CI`,
    };
  const diff = parseDiffArtifact(artifact.body);
  if (!diff) return { missing: `the diff of ${v} on the issue can't be read` };
  if (diff.sha256 !== version.sha256)
    return { missing: `the diff on the issue is of other SQL than ${v}'s` };
  if (diff.effect !== effectHash(diff) || diff.effect !== check.effect)
    return {
      missing: `the diff on the issue doesn't match CI's latest check of ${v}; label the issue changeset:recheck`,
    };
  return diff;
}
