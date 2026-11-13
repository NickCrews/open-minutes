// The comments CI posts on a changeset's issue: the check of a version, and
// the result of applying it. Each starts with the marker issue.ts reads.

import { statementEffects } from "./build";
import type { Check } from "./issue";
import { describeRows, meetingName, statementSummary } from "./render";
import type { ChangesetDiff, VersionRef } from "./types";

/**
 * Where a check's review page is: an artifact on the issue, or, when it
 * couldn't be attached, the run's artifacts, and why.
 */
export type PageLink = { url: string } | { unattached: string };

/**
 * The check of a version: whether it would apply, what it would change and
 * which rule violations it would resolve and introduce, each statement's
 * changes in a line, and links to the review page and the run. `why` says
 * why CI checked it again, and `previous`, CI's last check of the same
 * version, what changed since.
 */
export function checkComment(
  diff: ChangesetDiff & { version: VersionRef },
  {
    page,
    runUrl,
    why,
    previous,
  }: { page: PageLink; runUrl?: string; why?: string; previous?: Check },
): string {
  const v = diff.version.version;
  const meetings = new Map(diff.meetings.map((m) => [m.id, m]));
  const effects = statementEffects(diff).map((e) => e.slice(0, 12));
  const lines = [
    `<!-- changeset:check v${v} sha256=${diff.sha256} effect=${diff.effect} ${diff.error ? "fails" : "ok"} -->`,
    `<!-- changeset:effects ${effects.join(" ")} -->`,
  ];
  if (why) lines.push(`_${why}_`, "");
  if (previous) lines.push(`_${sinceLast(previous, diff, effects)}_`, "");
  if (diff.error) {
    const at =
      diff.error.statement === null
        ? ""
        : ` at #${diff.error.statement + 1} (line ${diff.statements[diff.error.statement]!.line})`;
    lines.push(
      `### ❌ [v${v}](${diff.version.url}) fails${at}`,
      "",
      `${diff.error.message}. Checked against \`${diff.base.db}\` at ${diff.base.ranAt}; nothing would be saved.`,
    );
  } else {
    const resolved = diff.outcomes.reduce((n, o) => n + o.resolved.length, 0);
    const introduced = diff.outcomes.reduce(
      (n, o) => n + o.introduced.length,
      0,
    );
    lines.push(
      `### ✅ [v${v}](${diff.version.url}) would apply`,
      "",
      `Checked against \`${diff.base.db}\` at ${diff.base.ranAt}: would change ${describeRows(diff.rows)}; in ${diff.outcomes.length} meeting(s), resolves ${resolved} rule violation(s) and introduces ${introduced}.`,
    );
    for (const o of diff.outcomes) {
      if (!o.resolved.length && !o.introduced.length) continue;
      const name = meetingName(
        meetings.get(o.meeting) ?? { id: o.meeting, slug: null },
      );
      lines.push("", `\`${name}\`:`);
      for (const i of o.resolved)
        lines.push(
          `- resolves ${i.severity} \`${i.code}\` ${i.where}: ${i.message}`,
        );
      for (const i of o.introduced)
        lines.push(
          `- **introduces** ${i.severity} \`${i.code}\` ${i.where}: ${i.message}`,
        );
    }
  }
  const links =
    "url" in page
      ? [`[Review page](${page.url}), in the issue's artifacts`]
      : [
          `The review page couldn't be attached to the issue (${page.unattached})${runUrl ? `; it's in [the run](${runUrl})'s artifacts` : ""}`,
        ];
  if (runUrl && "url" in page) links.push(`[run](${runUrl})`);
  lines.push("", links.join(" · "), "");

  const rows = diff.statements.map((s) => {
    const status =
      s.status === "ok"
        ? describeRows(s.rows)
        : s.status === "failed"
          ? "**failed**"
          : "not run";
    const summary = statementSummary(s, meetings);
    return `| ${s.index + 1} | ${s.line} | \`${s.kind}\` | ${status} | ${cell(summary)} |`;
  });
  lines.push(
    `<details><summary>${diff.statements.length} statements</summary>`,
    "",
    "| # | Line | Kind | Rows | Changes |",
    "| - | - | - | - | - |",
    ...rows,
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

/**
 * What changed since CI's last check of the same version: whether it now
 * fails or applies, and which statements do something else.
 */
export function sinceLast(
  previous: Check,
  diff: Pick<ChangesetDiff, "effect" | "error">,
  effects: string[],
): string {
  const last = `[the last check](${previous.url})`;
  if (previous.ok && diff.error) return `Applied at ${last}; fails now.`;
  if (!previous.ok && !diff.error) return `Failed at ${last}; applies now.`;
  if (previous.effect === diff.effect)
    return `Does what it did at ${last}: production changed nothing it changes.`;
  const changed = previous.statements
    ? effects
        .map((e, i) => (previous.statements![i] === e ? null : `#${i + 1}`))
        .filter((n) => n !== null)
    : [];
  return changed.length
    ? `Does something different from ${last}: ${changed.join(", ")} now ${changed.length === 1 ? "changes" : "change"} other data. Reviews of the last check don't cover ${changed.length === 1 ? "it" : "them"}.`
    : `Does something different from ${last}. Reviews of the last check don't cover it.`;
}

/** The result of applying a version. */
export function appliedComment(
  version: VersionRef,
  sha256: string,
  result: { rows: string; meetings: string[]; approver: string },
): string {
  return [
    `<!-- changeset:applied v${version.version} sha256=${sha256} -->`,
    `### Applied [v${version.version}](${version.url})`,
    "",
    `Approved by @${result.approver}. Saved ${result.rows}${result.meetings.length ? `; meetings changed: ${result.meetings.map((m) => `\`${m}\``).join(", ")}` : ""}.`,
    "",
  ].join("\n");
}

/** Text for a Markdown table cell. */
function cell(text: string): string {
  const t = text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}
