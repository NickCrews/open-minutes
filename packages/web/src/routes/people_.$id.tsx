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
    <div>
      <h1>{person().name || "(unnamed)"}</h1>
      <h2>Segments</h2>
      <For each={person().segments} fallback={<p>No segments yet.</p>}>
        {(segment) => (
          <p>
            <Link
              to="/meetings/$id"
              params={{ id: String(segment.meeting.id) }}
            >
              {segment.meeting.title || "(untitled)"}
            </Link>
            : {segment.text}
          </p>
        )}
      </For>
    </div>
  );
}
