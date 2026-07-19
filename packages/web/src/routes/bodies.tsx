import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getAllBodies } from "~/features/bodies";
import { db } from "~/server/db";

const fetchBodies = createServerFn({ method: "GET" }).handler(() =>
  getAllBodies(db()),
);

export const Route = createFileRoute("/bodies")({
  loader: () => fetchBodies(),
  component: BodiesPage,
});

function BodiesPage() {
  const bodies = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">Boards &amp; Councils</h1>
      <ul class="divide-y">
        <For
          each={bodies()}
          fallback={<li class="text-muted-foreground py-2">No bodies yet.</li>}
        >
          {(body) => (
            <li class="py-2">
              <Link
                to="/bodies/$id"
                params={{ id: String(body.id) }}
                class="font-medium hover:underline"
              >
                {body.name || "(unnamed)"}
              </Link>
              <Show when={body.jurisdiction.name}>
                {(name) => (
                  <span class="text-muted-foreground text-sm">
                    {" "}
                    — {name()}
                    {body.jurisdiction.state
                      ? `, ${body.jurisdiction.state}`
                      : ""}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
