import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For } from "solid-js";
import { getAllPeople } from "~/features/people";
import { db } from "~/server/db";

const fetchPeople = createServerFn({ method: "GET" }).handler(() =>
  getAllPeople(db()),
);

export const Route = createFileRoute("/people")({
  loader: () => fetchPeople(),
  component: PeoplePage,
});

function PeoplePage() {
  const people = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">People</h1>
      <ul class="divide-y">
        <For
          each={people()}
          fallback={<li class="text-muted-foreground py-2">No people yet.</li>}
        >
          {(person) => (
            <li class="py-2">
              <Link
                to="/people/$id"
                params={{ id: String(person.id) }}
                class="font-medium hover:underline"
              >
                {person.name || "(unnamed)"}
              </Link>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
