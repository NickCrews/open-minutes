import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For } from "solid-js";
import { getPersonById } from "~/features/people";
import { db } from "~/server/db";

const fetchPerson = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getPersonById(db(), data));

export const Route = createFileRoute("/people_/$id")({
  loader: ({ params }) => fetchPerson({ data: Number(params.id) }),
  component: PersonPage,
});

function PersonPage() {
  const person = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">{person().name || "(unnamed)"}</h1>
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Segments</h2>
      <div class="flex flex-col gap-3">
        <For
          each={person().segments}
          fallback={<p class="text-muted-foreground">No segments yet.</p>}
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
              : {segment.text}
            </p>
          )}
        </For>
      </div>
    </div>
  );
}
