// A changeset's diff as HTML: a header saying whether it would apply and what
// it would change, then a card per statement with its comment, SQL, changes,
// before-and-after hunks, rule violations and a review form. Pure, so the
// website can render a diff in the browser too; client.js makes the review
// form work.

import { formatClock } from "@open-minutes/core/clock";
import type {
  Change,
  ChangesetDiff,
  FieldChange,
  Hunk,
  IssueView,
  RowCount,
  SegmentView,
  StatementDiff,
} from "./types";

/** The id of the element holding the diff as JSON, which client.js reads. */
export const DIFF_ELEMENT_ID = "changeset-diff";

const esc = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One change in a line: `"good wood" -> "Girdwood" at 0:10:44.08`. */
export function describeChange(change: Change): string {
  const at = formatClock(change.start);
  switch (change.kind) {
    case "words":
      if (!change.new) return `deletes "${change.old}" at ${at}`;
      if (!change.old) return `inserts "${change.new}" at ${at}`;
      return `"${change.old}" -> "${change.new}" at ${at}`;
    case "speaker":
      return `${change.old} -> ${change.new} from ${at}`;
    case "boundary":
      return change.split
        ? `starts a new segment of the same speaker at ${at}`
        : `joins the segment before at ${at}`;
  }
}

/** "segments 2 updated, 1 deleted; people 1 updated", or "no rows". */
export function describeRows(rows: Record<string, RowCount>): string {
  const tables = Object.entries(rows);
  if (!tables.length) return "no rows";
  return tables
    .map(([table, counts]) => {
      const parts = (["updated", "inserted", "deleted"] as const)
        .filter((k) => counts[k])
        .map((k) => `${counts[k]} ${k}`);
      return `${table} ${parts.join(", ")}`;
    })
    .join("; ");
}

/** The diff as a full HTML page, with `script` (client.js) inlined. */
export function renderPage(diff: ChangesetDiff, script: string): string {
  const name = diff.meeting.slug ?? `meeting ${diff.meeting.id}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changeset · ${esc(name)}</title>
<style>${STYLES}</style>
</head>
<body>
${renderReport(diff)}
<script>${script.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
}

/** The diff as one element, `<div class="cv">`, with the diff as JSON inside it. */
export function renderReport(diff: ChangesetDiff): string {
  const m = diff.meeting;
  const ran = diff.statements.filter((s) => s.status === "ok").length;
  const banner = diff.error
    ? `<div class="banner fail"><strong>Fails${
        diff.error.statement === null
          ? ""
          : ` at #${diff.error.statement + 1} (line ${diff.statements[diff.error.statement]!.line})`
      }:</strong> ${esc(diff.error.message)}. ${ran} of ${diff.statements.length} statements ran; nothing would be saved.</div>`
    : `<div class="banner ok"><strong>Would apply.</strong> Changes ${esc(describeRows(diff.rows))}; resolves ${diff.resolved.length} rule violation(s), introduces ${diff.introduced.length}.</div>`;
  const source = diff.source
    ? /^https?:\/\//.test(diff.source)
      ? `<a href="${esc(diff.source)}">${esc(diff.source)}</a>`
      : `<code>${esc(diff.source)}</code>`
    : null;
  return `<div class="cv">
<header class="cv-header">
<h1>Changeset for ${esc(m.title)}</h1>
<p class="meta">Meeting <code>${esc(m.slug ?? String(m.id))}</code>${m.date ? ` on ${esc(m.date)}` : ""}, id ${m.id}. Checked against <code>${esc(diff.base.db)}</code> at ${esc(diff.base.ranAt)}${source ? `, from ${source}` : ""}.</p>
${banner}
${renderIssues("Resolves", diff.resolved, "resolved")}
${renderIssues("Introduces", diff.introduced, "introduced")}
</header>
<div class="toolbar">
<span class="tally" data-tally>${diff.statements.length} statements</span>
<button type="button" data-copy-markdown>Copy review as Markdown</button>
<button type="button" data-download-json>Download diff JSON</button>
<button type="button" data-clear-review>Clear review</button>
</div>
<details class="overall">
<summary>Overall note</summary>
<textarea data-overall rows="3" placeholder="A note on the whole changeset, at the top of the Markdown"></textarea>
</details>
<pre class="markdown-out" data-markdown hidden></pre>
<main>
${diff.statements.map(renderStatement).join("\n")}
</main>
<script type="application/json" id="${DIFF_ELEMENT_ID}">${JSON.stringify(diff).replaceAll("<", "\\u003c")}</script>
</div>`;
}

function renderStatement(s: StatementDiff): string {
  const summary = s.changes.map(describeChange).join("; ");
  const head = [
    `<a class="num" href="#s${s.index + 1}">#${s.index + 1}</a>`,
    `<span class="kind">${esc(s.kind)}</span>`,
    s.at === null ? "" : `<span class="at">${formatClock(s.at)}</span>`,
    `<span class="line">line ${s.line}</span>`,
    s.status === "ok"
      ? `<span class="rows">${esc(describeRows(s.rows))}</span>`
      : `<span class="status ${s.status}">${s.status === "failed" ? "failed" : "not run"}</span>`,
  ].join(" ");
  const body: string[] = [];
  if (s.comment)
    body.push(`<blockquote class="comment">${esc(s.comment)}</blockquote>`);
  body.push(`<pre class="sql">${esc(s.sql)}</pre>`);
  if (s.status === "ok") {
    if (s.kind === "assert")
      body.push(`<p class="holds">The assertion holds.</p>`);
    if (s.changes.length)
      body.push(
        `<ul class="changes">${s.changes.map((c) => `<li>${esc(describeChange(c))}</li>`).join("")}</ul>`,
      );
    body.push(...s.hunks.map(renderHunk));
    if (s.fields.length) body.push(renderFields(s.fields));
    if (!s.changes.length && !s.fields.length && s.kind !== "assert")
      body.push(
        `<p class="quiet">Changes nothing in this meeting's transcript.</p>`,
      );
    body.push(renderIssues("Resolves", s.resolved, "resolved"));
    body.push(renderIssues("Introduces", s.introduced, "introduced"));
  }
  return `<section class="stmt ${s.status}" id="s${s.index + 1}" data-index="${s.index}" data-line="${s.line}" data-kind="${esc(s.kind)}" data-at="${s.at === null ? "" : formatClock(s.at)}" data-summary="${esc(summary)}">
<div class="stmt-head">${head}</div>
${body.join("\n")}
<div class="review">
<label><input type="radio" name="v${s.index}" value="accept"> Accept</label>
<label><input type="radio" name="v${s.index}" value="reject"> Reject</label>
<label><input type="radio" name="v${s.index}" value="question"> Question</label>
<textarea rows="1" placeholder="Note" data-note></textarea>
</div>
</section>`;
}

function renderHunk(hunk: Hunk): string {
  return `<div class="hunk">
<div class="side before"><div class="side-name">Before</div>${hunk.before.map(renderSegment).join("")}</div>
<div class="side after"><div class="side-name">After</div>${hunk.after.map(renderSegment).join("")}</div>
</div>`;
}

function renderSegment(seg: SegmentView): string {
  const words = seg.items
    .map((item) =>
      "gap" in item
        ? `<span class="gap">${item.gap} word${item.gap === 1 ? "" : "s"}</span>`
        : `<span class="w${item.mark ? ` ${item.mark}` : ""}" title="${formatClock(item.start)}">${esc(item.text)}</span>`,
    )
    .join(" ");
  const name = seg.speaker.name
    ? `<span class="speaker">${esc(seg.speaker.name)}</span> `
    : "";
  return `<div class="seg${seg.changed ? " changed" : ""}">
<div class="seg-head">${name}<code class="label">${esc(seg.speaker.label)}</code> <span class="time">${formatClock(seg.start)}</span> <span class="segno">seg ${seg.index}</span></div>
<p class="words">${words}</p>
</div>`;
}

function renderFields(fields: FieldChange[]): string {
  const value = (v: string | null) => (v === null ? `<em>null</em>` : esc(v));
  return `<table class="fields"><tr><th>Row</th><th>Field</th><th>Before</th><th>After</th></tr>${fields
    .map(
      (f) =>
        `<tr><td>${esc(f.row)}</td><td>${esc(f.field)}</td><td class="old">${value(f.old)}</td><td class="new">${value(f.new)}</td></tr>`,
    )
    .join("")}</table>`;
}

function renderIssues(
  verb: string,
  issues: IssueView[],
  cls: "resolved" | "introduced",
): string {
  if (!issues.length) return "";
  return `<details class="issues ${cls}"${cls === "introduced" ? " open" : ""}>
<summary>${verb} ${issues.length} rule violation${issues.length === 1 ? "" : "s"}</summary>
<ul>${issues
    .map(
      (i) =>
        `<li><span class="sev ${i.severity}">${i.severity}</span> <code>${esc(i.code)}</code> ${esc(i.where)}: ${esc(i.message)}</li>`,
    )
    .join("")}</ul>
</details>`;
}

export const STYLES = `
.cv {
  --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e2e2e6; --card: #fafafb;
  --del-bg: #ffe1e1; --del-fg: #8a1010; --ins-bg: #d8f5dd; --ins-fg: #0d5a1d;
  --changed: #c77700; --ok: #0d6b2a; --fail: #a11212; --accent: #2457c5;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); background: var(--bg);
  max-width: 1200px; margin: 0 auto; padding: 16px;
}
@media (prefers-color-scheme: dark) {
  .cv {
    --bg: #161618; --fg: #e8e8ea; --muted: #9a9aa2; --line: #34343a; --card: #1e1e21;
    --del-bg: #4a1c1c; --del-fg: #ffb4b4; --ins-bg: #173d21; --ins-fg: #a9eab6;
    --changed: #f0a43a; --ok: #6fd28d; --fail: #ff8a8a; --accent: #8fb0ff;
  }
}
body:has(> .cv) { margin: 0; background: #fff; }
@media (prefers-color-scheme: dark) { body:has(> .cv) { background: #161618; } }
.cv h1 { font-size: 1.4rem; margin: 0 0 4px; }
.cv code, .cv pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
.cv .meta { color: var(--muted); margin: 0 0 12px; }
.cv a { color: var(--accent); }
.cv .banner { padding: 8px 12px; border-radius: 6px; margin: 8px 0; border: 1px solid var(--line); }
.cv .banner.ok { border-color: var(--ok); }
.cv .banner.fail { border-color: var(--fail); color: var(--fail); }
.cv .toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px 0; background: var(--bg); border-bottom: 1px solid var(--line); }
.cv .toolbar .tally { margin-right: auto; color: var(--muted); }
.cv button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); cursor: pointer; }
.cv button:hover { border-color: var(--accent); }
.cv textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 4px 8px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg); color: var(--fg); resize: vertical; }
.cv .overall { margin: 8px 0; }
.cv .markdown-out { white-space: pre-wrap; padding: 8px; border: 1px dashed var(--line); border-radius: 6px; }
.cv .stmt { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 10px 12px; margin: 12px 0; }
.cv .stmt.failed { border-color: var(--fail); }
.cv .stmt.not-run { opacity: 0.55; }
.cv .stmt[data-verdict="accept"] { border-left: 4px solid var(--ok); }
.cv .stmt[data-verdict="reject"] { border-left: 4px solid var(--fail); }
.cv .stmt[data-verdict="question"] { border-left: 4px solid var(--changed); }
.cv .stmt-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.cv .stmt-head .num { font-weight: 600; text-decoration: none; }
.cv .stmt-head .kind { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; }
.cv .stmt-head .at, .cv .stmt-head .line, .cv .stmt-head .rows { color: var(--muted); font-size: 0.9em; }
.cv .status.failed { color: var(--fail); font-weight: 600; }
.cv .status.not-run { color: var(--muted); }
.cv .comment { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--line); white-space: pre-wrap; }
.cv .sql { margin: 6px 0; padding: 6px 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.cv .changes { margin: 6px 0; padding-left: 20px; }
.cv .holds, .cv .quiet { color: var(--muted); margin: 6px 0; }
.cv .hunk { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
@media (max-width: 760px) { .cv .hunk { grid-template-columns: 1fr; } }
.cv .side { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: var(--bg); min-width: 0; }
.cv .side-name { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.cv .seg { margin: 4px 0; padding-left: 8px; border-left: 3px solid var(--line); }
.cv .seg.changed { border-left-color: var(--changed); }
.cv .seg.changed .seg-head { color: var(--changed); }
.cv .seg-head { font-size: 0.85em; color: var(--muted); }
.cv .seg-head .speaker { color: var(--fg); font-weight: 600; }
.cv .seg.changed .seg-head .speaker { color: var(--changed); }
.cv .words { margin: 2px 0; overflow-wrap: anywhere; }
.cv .w.del { background: var(--del-bg); color: var(--del-fg); text-decoration: line-through; }
.cv .w.ins { background: var(--ins-bg); color: var(--ins-fg); }
.cv .gap { color: var(--muted); font-size: 0.8em; font-style: italic; }
.cv .gap::before { content: "["; } .cv .gap::after { content: "]"; }
.cv .fields { border-collapse: collapse; margin: 8px 0; font-size: 0.9em; }
.cv .fields td, .cv .fields th { border: 1px solid var(--line); padding: 2px 6px; text-align: left; vertical-align: top; }
.cv .fields .old { background: var(--del-bg); color: var(--del-fg); }
.cv .fields .new { background: var(--ins-bg); color: var(--ins-fg); }
.cv .issues { margin: 6px 0; font-size: 0.9em; }
.cv .issues ul { margin: 4px 0; padding-left: 20px; }
.cv .issues.resolved summary { color: var(--ok); }
.cv .issues.introduced summary { color: var(--fail); }
.cv .sev { font-size: 0.8em; text-transform: uppercase; }
.cv .sev.error { color: var(--fail); } .cv .sev.warning { color: var(--changed); }
.cv .review { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; margin-top: 8px;
  padding-top: 8px; border-top: 1px solid var(--line); }
.cv .review textarea { flex: 1 1 240px; width: auto; }
`;
