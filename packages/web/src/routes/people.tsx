import { createFileRoute, Link, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { TextField, TextFieldInput } from "~/components/text-field";
import { type Attendance, getAllPeople } from "~/features/people";
import { matchesName } from "~/features/people/search";
import { formatMonthYear } from "~/lib/format";
import { db } from "~/server/db";

const fetchPeople = createServerFn({ method: "GET" }).handler(() =>
  getAllPeople(db()),
);

export const Route = createFileRoute("/people")({
  // Optional, so plain links to /people need no search params and an empty
  // box leaves no dangling "?q=" in the URL.
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q ? { q: search.q } : {},
  // Filtering happens client-side over the whole list, so `q` is deliberately
  // not a loader dep: typing mustn't refetch everyone on each keystroke.
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

/** "37 people", or "3 of 37 people" while a search narrows the list. */
function formatPeopleCount(shown: number, total: number): string {
  const noun = total === 1 ? "person" : "people";
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

function PeoplePage() {
  const people = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();

  // The box filters as you type, so it keeps its own copy of the query rather
  // than reading the URL, which only catches up after navigation resolves.
  const [query, setQuery] = createSignal(search().q ?? "");
  // Follow URL changes made elsewhere, eg the "People" nav link clearing it.
  createEffect(
    on(
      () => search().q ?? "",
      (q) => setQuery(q),
      { defer: true },
    ),
  );
  const onQueryChange = (q: string) => {
    setQuery(q);
    // Replace, not push: each keystroke shouldn't become a history entry.
    void navigate({
      to: "/people",
      search: q ? { q } : {},
      replace: true,
    });
  };

  const filtered = createMemo(() =>
    people().filter((person) => matchesName(person.name, query())),
  );

  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">People</h1>
      <div class="mb-4 flex items-center gap-4">
        <TextField value={query()} onChange={onQueryChange} class="flex-1">
          <TextFieldInput
            type="search"
            placeholder="Search by name…"
            aria-label="Search people by name"
          />
        </TextField>
        <p class="text-muted-foreground shrink-0 text-sm" aria-live="polite">
          {formatPeopleCount(filtered().length, people().length)}
        </p>
      </div>
      <ul class="divide-y">
        <For
          each={filtered()}
          fallback={
            <li class="text-muted-foreground py-2">
              {people().length ? "No matching people." : "No people yet."}
            </li>
          }
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
