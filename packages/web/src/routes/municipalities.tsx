import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For } from "solid-js";
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
    <div>
      <h1>Municipalities</h1>
      <ul>
        <For each={municipalities()} fallback={<li>No municipalities yet.</li>}>
          {(municipality) => (
            <li>
              <Link
                to="/municipalities/$id"
                params={{ id: String(municipality.id) }}
              >
                {municipality.name || "(unnamed)"}
              </Link>
              {municipality.state ? `, ${municipality.state}` : ""}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
