import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createMemo, For, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { createHiddenPlayer } from "~/features/meetings/hidden-player";
import {
  groupByMeeting,
  MeetingExcerptCard,
} from "~/features/meetings/meeting-excerpt-card";
import { searchSegments } from "~/features/search";
import { db } from "~/server/db";
import { z } from "zod";

const fetchSearchResults = createServerFn({ method: "GET" })
  .inputValidator(z.string())
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
  const player = createHiddenPlayer();
  const groups = createMemo(() => groupByMeeting(results()));
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
        <div class="flex flex-col gap-4">
          <For
            each={groups()}
            fallback={<p class="text-muted-foreground">No results.</p>}
          >
            {(group) => (
              <MeetingExcerptCard
                meeting={group.meeting}
                hits={group.hits}
                noun={["match", "matches"]}
                query={search().q}
                showSpeakers
                player={player}
                // Nothing to choose between, so skip the click.
                defaultExpanded={groups().length === 1}
              />
            )}
          </For>
        </div>
      </Show>
      <div
        ref={player.setHost}
        aria-hidden="true"
        class="pointer-events-none fixed right-0 bottom-0 h-px w-px overflow-hidden opacity-0"
      />
    </div>
  );
}
