import { createFileRoute, Link, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { searchSegments } from "~/features/search";
import { db } from "~/server/db";

const fetchSearchResults = createServerFn({ method: "GET" })
  .inputValidator((query: string) => query)
  .handler(({ data }) => searchSegments(db(), data));

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) =>
    deps.q ? fetchSearchResults({ data: deps.q }) : Promise.resolve([]),
  component: SearchPage,
});

function SearchPage() {
  const results = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <div>
      <h1>Search</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get("q");
          void navigate({ to: "/search", search: { q: String(q ?? "") } });
        }}
      >
        <input
          type="search"
          name="q"
          value={search().q}
          placeholder="Search transcripts…"
        />
        <button type="submit">Search</button>
      </form>
      <Show when={search().q}>
        <h2>Results for “{search().q}”</h2>
        <For each={results()} fallback={<p>No results.</p>}>
          {(segment) => (
            <p>
              <Link
                to="/meetings/$id"
                params={{ id: String(segment.meeting.id) }}
              >
                {segment.meeting.title || "(untitled)"}
              </Link>
              <Show when={segment.person}>
                {(person) => <> — {person().name || "(unnamed)"}</>}
              </Show>
              : {segment.text}
            </p>
          )}
        </For>
      </Show>
    </div>
  );
}
