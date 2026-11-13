// The review page of a changeset proposed in a GitHub issue: what CI's check
// of a version found each statement does, with a form for a verdict and note
// on each, which copies the review as a comment to post on the issue. It reads
// the issue and the diff CI published on it, and writes nothing. It isn't
// linked from the site; CI's check comments link to it. See
// packages/changeset-review/README.md.
import { createFileRoute, Link } from "@tanstack/solid-router";
import { createEffect, For, Show, type JSX } from "solid-js";
import { renderReport, STYLES } from "@open-minutes/changeset-review";
import clientScript from "@open-minutes/changeset-review/client.js?raw";
import { fetchChangesetReview } from "~/server/changesets";

export const Route = createFileRoute("/changesets_/$issue")({
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = Number(search.v);
    return Number.isInteger(v) && v > 0 ? { v } : {};
  },
  loaderDeps: ({ search }) => ({ v: search.v }),
  loader: ({ params, deps }) =>
    fetchChangesetReview({
      data: { issue: Number(params.issue), version: deps.v },
    }),
  head: ({ params }) => ({
    meta: [
      { title: `Changeset #${params.issue} · Open Minutes` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ChangesetPage,
});

function ChangesetPage(): JSX.Element {
  const review = Route.useLoaderData();
  const page = () => review().page;
  const diff = () => {
    const d = page()?.diff;
    return d && !("missing" in d) ? d : null;
  };
  let report: HTMLDivElement | undefined;

  // The review form's script, run again for each diff the page shows. It's a
  // plain script, so it runs in a scope of its own.
  createEffect(() => {
    if (!diff() || !report) return;
    queueMicrotask(() => {
      const script = document.createElement("script");
      script.textContent = `(() => {\n${clientScript}\n})();`;
      report!.append(script);
    });
  });

  const state = () => {
    const i = review().issue;
    if (i.applied) return "applied";
    if (i.approved) return "approved";
    return i.open ? "open" : "closed";
  };

  return (
    <div class="mx-auto max-w-6xl">
      <div class="mb-2 text-sm text-muted-foreground">
        <a class="underline" href={review().issue.url}>
          {review().repo}#{review().issue.number}
        </a>{" "}
        · {state()}
      </div>
      <h1 class="mb-2 text-2xl font-bold">{review().issue.title}</h1>
      <nav class="mb-3 flex flex-wrap gap-2 text-sm">
        <For each={review().versions}>
          {(v) => (
            <Link
              to="/changesets/$issue"
              params={{ issue: String(review().issue.number) }}
              search={{ v: v.version }}
              class="rounded border px-2 py-0.5"
              classList={{
                "font-bold": v.version === page()?.version.version,
              }}
            >
              v{v.version}
            </Link>
          )}
        </For>
      </nav>
      <Show
        when={page()}
        fallback={<p>This issue has no such changeset version.</p>}
      >
        {(p) => (
          <>
            <p class="mb-2 text-sm">
              <a class="underline" href={p().version.url}>
                v{p().version.version}
              </a>{" "}
              by {p().version.author}.{" "}
              <Show
                when={p().check}
                fallback={<>CI hasn't checked it as it stands yet.</>}
              >
                {(c) => (
                  <>
                    <a class="underline" href={c().url}>
                      CI's latest check
                    </a>{" "}
                    found it {c().ok ? "would apply" : "fails"}.
                  </>
                )}
              </Show>{" "}
              To review it, mark each statement below, copy the review comment,
              and post it on{" "}
              <a
                class="underline"
                href={`${review().issue.url}#new_comment_field`}
              >
                the issue
              </a>
              .
            </p>
            <Show when={p().reviews.length}>
              <ul class="mb-3 list-disc pl-5 text-sm">
                <For each={p().reviews}>
                  {(r) => (
                    <li>
                      <a class="underline" href={r.url}>
                        Review by {r.author}
                      </a>
                      {r.trusted ? "" : " (no write access)"}
                      {r.stale
                        ? " (stale: it saw what the version did at an earlier check)"
                        : ""}
                      : {count(r.review.statements, "accept")} accepted,{" "}
                      {count(r.review.statements, "reject")} rejected,{" "}
                      {count(r.review.statements, "question")} questioned
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show
              when={diff()}
              fallback={
                <p role="alert" class="text-red-700 dark:text-red-400">
                  No review page: {missing(p().diff)}.
                </p>
              }
            >
              {(d) => (
                <div ref={report}>
                  <style innerHTML={STYLES} />
                  <div innerHTML={renderReport(d())} />
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function count(
  statements: { verdict: string | null }[],
  verdict: string,
): number {
  return statements.filter((s) => s.verdict === verdict).length;
}

function missing(diff: unknown): string {
  return (diff as { missing?: string }).missing ?? "";
}
