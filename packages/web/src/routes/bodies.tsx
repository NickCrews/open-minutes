import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { type Coverage, getAllBodies } from "~/features/bodies";
import { BodyThumbnail } from "~/features/bodies/body-thumbnail";
import { formatMonthYear } from "@open-minutes/core/meeting-date";
import { db } from "~/server/db";
import { PinIcon } from "~/components/icons";

const fetchBodies = createServerFn({ method: "GET" }).handler(() =>
  getAllBodies(db()),
);

export const Route = createFileRoute("/bodies")({
  loader: () => fetchBodies(),
  component: BodiesPage,
});

/**
 * How much of a body's record we hold, eg "42 meetings · Mar 2019 – Sep 2026".
 * Dates are wall-clock dates in each meeting's timezone, and a span within one month
 * collapses to that month so a lone meeting doesn't read "Mar 2019 – Mar 2019".
 */
function formatCoverage(c: Coverage): string {
  if (c.meetings === 0) return "No meetings yet";
  const count = `${c.meetings} ${c.meetings === 1 ? "meeting" : "meetings"}`;
  if (!c.first || !c.last) return count;
  const first = formatMonthYear(c.first);
  const last = formatMonthYear(c.last);
  return `${count} · ${first === last ? first : `${first} – ${last}`}`;
}

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
            <li class="flex items-center gap-4 py-3">
              <Link
                to="/bodies/$id"
                params={{ id: String(body.id) }}
                tabIndex={-1}
                class="w-28 shrink-0 sm:w-36"
              >
                <BodyThumbnail body={body} />
              </Link>
              <div class="min-w-0">
                <Link
                  to="/bodies/$id"
                  params={{ id: String(body.id) }}
                  class="font-medium hover:underline"
                >
                  {body.name || "(unnamed)"}
                </Link>
                <Show when={body.jurisdiction.name}>
                  {(name) => (
                    <p class="text-muted-foreground flex items-center gap-1 text-sm">
                      <PinIcon class="size-3.5 shrink-0" />
                      {name()}
                      {body.jurisdiction.state
                        ? `, ${body.jurisdiction.state}`
                        : ""}
                    </p>
                  )}
                </Show>
                <p class="text-muted-foreground text-sm">
                  {formatCoverage(body.coverage)}
                </p>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
