// The comments CI posts on a changeset's issue: the check of a version, and
// the result of applying it. Each starts with the marker issue.ts reads.

import { describeRows, meetingName, statementSummary } from "./render";
import type { ChangesetDiff, VersionRef } from "./types";

/** Stands for the review page's URL until the workflow has uploaded it. */
export const REVIEW_URL = "{{review_url}}";

/**
 * The check of a version: whether it would apply, what it would change and
 * which rule violations it would resolve and introduce, each statement's
 * changes in a line, and links to the review page and the run.
 */
export function checkComment(
  diff: ChangesetDiff & { version: VersionRef },
  { runUrl }: { runUrl?: string } = {},
): string {
  const v = diff.version.version;
  const meetings = new Map(diff.meetings.map((m) => [m.id, m]));
  const lines = [
    `<!-- changeset:check v${v} sha256=${diff.sha256} ${diff.error ? "fails" : "ok"} -->`,
  ];
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
  const links = [`[Review page](${REVIEW_URL}) (download and open it)`];
  if (runUrl) links.push(`[run](${runUrl})`);
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
