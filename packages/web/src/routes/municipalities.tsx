import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getAllMunicipalities } from "~/features/municipalities";
import { db } from "~/server/db";

const fetchMunicipalities = createServerFn({ method: "GET" }).handler(() =>
  getAllMunicipalities(db()),
);

export const Route = createFileRoute("/municipalities")({
  loader: () => fetchMunicipalities(),
  component: MunicipalitiesPage,
});

function MunicipalitiesPage() {
  const municipalities = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">Municipalities</h1>
      <ul class="divide-y">
        <For
          each={municipalities()}
          fallback={
            <li class="text-muted-foreground py-2">No municipalities yet.</li>
          }
        >
          {(municipality) => (
            <li class="py-2">
              <Link
                to="/municipalities/$id"
                params={{ id: String(municipality.id) }}
                class="font-medium hover:underline"
              >
                {municipality.name || "(unnamed)"}
              </Link>
              <Show when={municipality.state}>
                {(state) => (
                  <span class="text-muted-foreground text-sm">, {state()}</span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
