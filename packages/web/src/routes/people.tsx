import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { type Attendance, getAllPeople } from "~/features/people";
import { formatMonthYear } from "~/lib/format";
import { db } from "~/server/db";

const fetchPeople = createServerFn({ method: "GET" }).handler(() =>
  getAllPeople(db()),
);

export const Route = createFileRoute("/people")({
  loader: () => fetchPeople(),
  component: PeoplePage,
});

/**
 * One body's worth of a person's record, eg "5 GBOS meetings, Apr 2023–Feb
 * 2026". A span within a single month collapses to that month, so a person seen
 * once doesn't read as "Apr 2023–Apr 2023".
 */
function formatAttendance(a: Attendance): string {
  const count = `${a.meetings} ${a.body} ${a.meetings === 1 ? "meeting" : "meetings"}`;
  if (!a.first || !a.last) return count;
  const first = formatMonthYear(a.first, a.timezone);
  const last = formatMonthYear(a.last, a.timezone);
  return `${count}, ${first === last ? first : `${first}–${last}`}`;
}

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
              <div class="flex items-baseline gap-2">
                <Link
                  to="/people/$id"
                  params={{ id: String(person.id) }}
                  class="shrink-0 font-medium hover:underline"
                >
                  {person.name || "(unnamed)"}
                </Link>
                <Show when={person.attendance.length}>
                  <span class="text-muted-foreground min-w-0 truncate text-sm">
                    {person.attendance.map(formatAttendance).join(" · ")}
                  </span>
                </Show>
              </div>
              {/* Bios run to whatever length someone typed, so this one gets
                  clipped to a single line to keep the list scannable. */}
              <Show when={person.bio}>
                <p class="text-muted-foreground truncate text-sm">
                  {person.bio}
                </p>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
