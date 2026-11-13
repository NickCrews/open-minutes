// @ts-check
// The review form on a changeset page that render.ts writes: a verdict
// (accept, reject, question) and a note per statement, and a note on the
// whole changeset, kept in the browser's localStorage and exported as a
// review comment to paste into the changeset's issue. It runs as a plain
// script, inlined into the page or added to it by the website, and attaches
// to every `.cv` element on the page. `pnpm changeset review` formats its
// comments with reviewComment too.
//
// A verdict is kept by the statement's SQL, so it survives rerunning the
// changeset, or a new version of it, as long as that statement is unchanged.

/**
 * @typedef {{ verdicts: Record<string, string>, notes: Record<string, string>, overall: string }} ReviewState
 * @typedef {{ index: number, line: number, kind: string, at: string, summary: string, sql: string }} StatementInfo
 * @typedef {{
 *   version: { repo: string, issue: number, version: number } | null,
 *   sha256: string,
 *   effect: string | null,
 *   base: { db: string, ranAt: string } | null,
 *   source: string | null,
 *   error: { message: string, statement: number | null } | null,
 * }} DiffInfo
 */

const VERDICTS = /** @type {const} */ ({
  reject: "Rejected",
  question: "Question",
  accept: "Accepted",
});

/**
 * The review as an issue comment: the marker the flow reads it by (with a
 * version), a line of totals, the overall note, each rejected, questioned or
 * annotated statement, then the accepted ones, and the review as JSON.
 * @param {DiffInfo} diff
 * @param {StatementInfo[]} statements
 * @param {ReviewState} review
 * @returns {string}
 */
function reviewComment(diff, statements, review) {
  /** @type {Record<string, number>} */
  const counts = { accept: 0, reject: 0, question: 0, none: 0 };
  for (const s of statements) {
    const verdict = review.verdicts[s.sql] ?? "none";
    counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  const tally = [
    `${counts.accept} accepted`,
    `${counts.reject} rejected`,
    `${counts.question} with a question`,
    `${counts.none} not reviewed`,
  ].join(", ");
  const v = diff.version;
  const lines = [];
  if (v)
    lines.push(
      `<!-- changeset:review v${v.version} sha256=${diff.sha256}${diff.effect ? ` effect=${diff.effect}` : ""} -->`,
      `### Review of changeset v${v.version}`,
      "",
    );
  else lines.push(`### Review of ${diff.source ?? "a changeset"}`, "");
  lines.push(
    diff.base
      ? `Checked against \`${diff.base.db}\` at ${diff.base.ranAt}: ${tally}.`
      : `${tally}.`,
  );
  if (diff.error) lines.push("", `It fails: ${diff.error.message}.`);
  if (review.overall.trim()) lines.push("", review.overall.trim());

  const items = [];
  const quietlyAccepted = [];
  /** @type {{ statement: number, line: number, kind: string, verdict: string | null, note: string }[]} */
  const json = [];
  for (const s of statements) {
    const verdict = review.verdicts[s.sql];
    const note = (review.notes[s.sql] ?? "").trim();
    if (!verdict && !note) continue;
    json.push({
      statement: s.index + 1,
      line: s.line,
      kind: s.kind,
      verdict: verdict ?? null,
      note,
    });
    if (verdict === "accept" && !note) {
      quietlyAccepted.push(`#${s.index + 1}`);
      continue;
    }
    const label = verdict
      ? VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)]
      : "Note";
    const where = [`#${s.index + 1}`, `line ${s.line}`, `\`${s.kind}\``];
    if (s.at) where.push(`at ${s.at}`);
    let item = `- **${label}** ${where.join(", ")}`;
    if (s.summary) item += `: ${s.summary}`;
    if (note) item += `\n${note.replace(/^/gm, "  > ")}`;
    items.push(item);
  }
  if (quietlyAccepted.length)
    items.push(`- **Accepted** ${quietlyAccepted.join(", ")}`);
  if (items.length) lines.push("", ...items);
  // Backticks escaped, so a note can't close the block.
  const data = JSON.stringify(
    { overall: review.overall.trim(), statements: json },
    null,
    2,
  ).replaceAll("`", "\\u0060");
  lines.push(
    "",
    "<details><summary>Review as JSON</summary>",
    "",
    "```json",
    data,
    "```",
    "",
    "</details>",
  );
  return lines.join("\n") + "\n";
}

/**
 * Make the review form in `root`, a `.cv` element, work.
 * @param {HTMLElement} root
 */
function attachReview(root) {
  root.dataset.attached = "true";
  const json = root.querySelector("#changeset-diff");
  if (!json) return;
  /** @type {DiffInfo} */
  const diff = JSON.parse(json.textContent ?? "{}");
  const key = `changeset-review:${
    diff.version
      ? `${diff.version.repo}#${diff.version.issue}`
      : (diff.source ?? "local")
  }`;

  /** @type {ReviewState} */
  let review = { verdicts: {}, notes: {}, overall: "" };
  try {
    const saved = localStorage.getItem(key);
    if (saved) review = { ...review, ...JSON.parse(saved) };
  } catch {
    // No storage, as in a private window: the review lasts as long as the page.
  }
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(review));
    } catch {
      // As above.
    }
  };

  /** @type {HTMLElement[]} */
  const cards = Array.from(root.querySelectorAll("section.stmt"));
  /** @param {HTMLElement} card @returns {StatementInfo} */
  const info = (card) => ({
    index: Number(card.dataset.index),
    line: Number(card.dataset.line),
    kind: card.dataset.kind ?? "",
    at: card.dataset.at ?? "",
    summary: card.dataset.summary ?? "",
    sql: card.querySelector(".sql")?.textContent ?? "",
  });
  const tally = root.querySelector("[data-tally]");
  const refresh = () => {
    /** @type {Record<string, number>} */
    const counts = { accept: 0, reject: 0, question: 0 };
    for (const card of cards) {
      const verdict = review.verdicts[info(card).sql];
      if (verdict) {
        card.dataset.verdict = verdict;
        counts[verdict] = (counts[verdict] ?? 0) + 1;
      } else delete card.dataset.verdict;
    }
    if (tally)
      tally.textContent = `${cards.length} statements: ${counts.accept} accepted, ${counts.reject} rejected, ${counts.question} with a question`;
  };

  /** @param {HTMLElement} card */
  const bind = (card) => {
    const { sql } = info(card);
    /** @type {NodeListOf<HTMLInputElement>} */
    const radios = card.querySelectorAll("input[type=radio]");
    for (const radio of radios) {
      radio.checked = review.verdicts[sql] === radio.value;
      radio.addEventListener("change", () => {
        review.verdicts[sql] = radio.value;
        save();
        refresh();
      });
    }
    /** @type {HTMLTextAreaElement | null} */
    const note = card.querySelector("textarea[data-note]");
    if (note) {
      note.value = review.notes[sql] ?? "";
      note.addEventListener("input", () => {
        if (note.value) review.notes[sql] = note.value;
        else delete review.notes[sql];
        save();
      });
    }
  };
  cards.forEach(bind);

  /** @type {HTMLTextAreaElement | null} */
  const overall = root.querySelector("textarea[data-overall]");
  if (overall) {
    overall.value = review.overall;
    overall.addEventListener("input", () => {
      review.overall = overall.value;
      save();
    });
  }

  /** @type {HTMLElement | null} */
  const out = root.querySelector("[data-markdown]");
  root
    .querySelector("[data-copy-markdown]")
    ?.addEventListener("click", async (event) => {
      const md = reviewComment(diff, cards.map(info), review);
      if (out) {
        out.textContent = md;
        out.hidden = false;
      }
      const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
      try {
        await navigator.clipboard.writeText(md);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy it from below";
      }
      setTimeout(() => (button.textContent = "Copy review comment"), 2000);
    });

  root.querySelector("[data-download-json]")?.addEventListener("click", () => {
    const blob = new Blob([json.textContent ?? ""], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `changeset-${diff.sha256.slice(0, 12)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  root.querySelector("[data-clear-review]")?.addEventListener("click", () => {
    if (!confirm("Clear every verdict and note on this page?")) return;
    for (const card of cards) {
      const { sql } = info(card);
      delete review.verdicts[sql];
      delete review.notes[sql];
      for (const input of card.querySelectorAll("input[type=radio]"))
        /** @type {HTMLInputElement} */ (input).checked = false;
      const note = card.querySelector("textarea[data-note]");
      if (note) /** @type {HTMLTextAreaElement} */ (note).value = "";
    }
    review.overall = "";
    save();
    if (overall) overall.value = "";
    refresh();
  });

  refresh();
}

if (typeof document !== "undefined")
  for (const root of document.querySelectorAll(".cv"))
    if (root instanceof HTMLElement && !root.dataset.attached)
      attachReview(root);
