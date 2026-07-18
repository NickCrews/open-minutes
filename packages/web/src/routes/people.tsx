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
    <div>
      <h1>People</h1>
      <ul>
        <For each={people()} fallback={<li>No people yet.</li>}>
          {(person) => (
            <li>
              <Link to="/people/$id" params={{ id: String(person.id) }}>
                {person.name || "(unnamed)"}
              </Link>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
