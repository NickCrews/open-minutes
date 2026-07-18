import { createFileRoute, Link, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
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
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">Search</h1>
      <form
        class="mb-6 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get("q");
          void navigate({ to: "/search", search: { q: String(q ?? "") } });
        }}
      >
        <TextField name="q" defaultValue={search().q} class="flex-1">
          <TextFieldInput type="search" placeholder="Search transcripts…" />
        </TextField>
        <Button type="submit">Search</Button>
      </form>
      <Show when={search().q}>
        <h2 class="mb-4 border-b pb-2 text-lg font-semibold">
          Results for “{search().q}”
        </h2>
        <div class="flex flex-col gap-3">
          <For
            each={results()}
            fallback={<p class="text-muted-foreground">No results.</p>}
          >
            {(segment) => (
              <p class="leading-relaxed">
                <Link
                  to="/meetings/$id"
                  params={{ id: String(segment.meeting.id) }}
                  class="font-semibold hover:underline"
                >
                  {segment.meeting.title || "(untitled)"}
                </Link>
                <Show when={segment.person}>
                  {(person) => (
                    <span class="text-muted-foreground">
                      {" "}
                      — {person().name || "(unnamed)"}
                    </span>
                  )}
                </Show>
                : {segment.text}
              </p>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
