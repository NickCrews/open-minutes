import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { Button } from "~/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "~/components/hover-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/select";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getAllMeetings } from "~/features/meetings";
import { Duration } from "~/features/meetings/duration";
import {
  filterMeetings,
  groupByMonth,
  sortMeetings,
  summarizeMeetings,
} from "~/features/meetings/list";
import { MonthBadge } from "~/features/meetings/month-badge";
import { MeetingDateTime } from "~/features/meetings/meeting-date-time";
import { meetingSeeds, Thumbnail } from "~/features/thumbnails/thumbnail";
import { db } from "~/server/db";

const fetchMeetings = createServerFn({ method: "GET" }).handler(() =>
  getAllMeetings(db()),
);

/**
 * Filters live in the URL so a narrowed list can be bookmarked or shared.
 * Empty ones are left out rather than serialized as `?q=&body=[]`.
 */
export interface MeetingsSearch {
  q?: string;
  body?: number[];
}

export const Route = createFileRoute("/meetings")({
  validateSearch: (search: Record<string, unknown>): MeetingsSearch => {
    const q = typeof search.q === "string" && search.q ? search.q : undefined;
    const raw = Array.isArray(search.body) ? search.body : [search.body];
    const body = raw.map(Number).filter((id) => Number.isInteger(id));
    return { q, body: body.length ? body : undefined };
  },
  loader: () => fetchMeetings(),
  // Every meeting is loaded up front and filtered in the browser, so typing a
  // search (which rewrites the URL on each keystroke) shouldn't refetch them.
  // An explicit `router.invalidate()` still does.
  shouldReload: ({ cause }) => cause !== "stay",
  component: MeetingsPage,
});

type Meeting = Awaited<ReturnType<typeof getAllMeetings>>[number];
/** A body in the filter menu, with how many meetings it has. */
type BodyOption = { body: Meeting["body"]; count: number };

function MeetingsPage() {
  const meetings = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  // The box filters from its own signal so typing stays instant, and mirrors
  // into the URL; the URL flows back in on back/forward navigation.
  const [query, setQuery] = createSignal(search().q ?? "");
  createEffect(
    on(
      () => search().q ?? "",
      (q) => {
        if (q !== query()) setQuery(q);
      },
      { defer: true },
    ),
  );
  const setSearch = (patch: MeetingsSearch) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });

  const sorted = createMemo(() => sortMeetings(meetings()));
  const bodies = createMemo(() => {
    const byId = new Map<number, BodyOption>();
    for (const m of meetings()) {
      const entry = byId.get(m.body.id) ?? { body: m.body, count: 0 };
      entry.count++;
      byId.set(m.body.id, entry);
    }
    return [...byId.values()].sort((a, b) =>
      a.body.name.localeCompare(b.body.name),
    );
  });
  const selectedBodies = createMemo(() => {
    const ids = new Set(search().body ?? []);
    return bodies().filter((b) => ids.has(b.body.id));
  });
  const filtered = createMemo(() =>
    filterMeetings(sorted(), { q: query(), bodies: search().body }),
  );
  const groups = createMemo(() => groupByMonth(filtered()));
  const isFiltered = () => !!query().trim() || !!search().body?.length;

  const clearFilters = () => {
    setQuery("");
    setSearch({ q: undefined, body: undefined });
  };

  let list: HTMLDivElement | undefined;

  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-1 text-2xl font-bold">Meetings</h1>
      <p class="text-muted-foreground mb-4 text-sm" aria-live="polite">
        {summarizeMeetings(filtered(), meetings().length)}
      </p>
      <div class="mb-6 flex flex-col gap-2 sm:flex-row">
        <TextField
          value={query()}
          onChange={(q) => {
            setQuery(q);
            setSearch({ q: q || undefined });
          }}
          class="flex-1"
        >
          <TextFieldInput
            type="search"
            placeholder="Search by title or body…"
            aria-label="Search meetings"
          />
        </TextField>
        <Select<BodyOption>
          multiple
          options={bodies()}
          optionValue={(o) => o.body.id}
          optionTextValue={(o) => o.body.name}
          value={selectedBodies()}
          onChange={(selected) =>
            setSearch({
              body: selected.length
                ? selected.map((o) => o.body.id)
                : undefined,
            })
          }
          placeholder="All bodies"
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {props.item.rawValue.body.name}
              <span class="text-muted-foreground ml-2 text-xs">
                {props.item.rawValue.count}
              </span>
            </SelectItem>
          )}
        >
          <SelectTrigger aria-label="Filter by body" class="sm:w-56">
            <SelectValue<BodyOption> class="truncate">
              {(state) =>
                state.selectedOptions().length === 1
                  ? state.selectedOption().body.name
                  : `${state.selectedOptions().length} bodies`
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <Show when={isFiltered()}>
          <Button variant="ghost" onClick={clearFilters}>
            Clear
          </Button>
        </Show>
      </div>

      <MonthBadge container={() => list} />

      <div ref={list} class="flex flex-col gap-8">
        <For
          each={groups()}
          fallback={
            <p class="text-muted-foreground">
              {meetings().length
                ? "No meetings match these filters."
                : "No meetings yet."}
            </p>
          }
        >
          {(group) => {
            const label = group.month?.long ?? "Date unknown";
            return (
              <section data-month-label={label}>
                <h2 class="text-muted-foreground mb-3 text-sm font-semibold">
                  {label}
                </h2>
                <div class="flex flex-col gap-4">
                  <For each={group.meetings}>
                    {(meeting) => (
                      <MeetingCard
                        meeting={meeting}
                        onSaved={() => void router.invalidate()}
                      />
                    )}
                  </For>
                </div>
              </section>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function MeetingCard(props: { meeting: Meeting; onSaved: () => void }) {
  return (
    <Card class="flex-row gap-0 overflow-hidden py-0">
      <Link
        to="/meetings/$id"
        params={{ id: String(props.meeting.id) }}
        tabIndex={-1}
        class="w-32 shrink-0 self-center py-4 pl-4 sm:w-44"
      >
        <Thumbnail
          youtubeId={props.meeting.youtube_id}
          seeds={meetingSeeds(props.meeting)}
        />
      </Link>
      <div class="flex min-w-0 flex-1 flex-col gap-3 py-4">
        <CardHeader>
          <CardTitle>
            <Link
              to="/meetings/$id"
              params={{ id: String(props.meeting.id) }}
              class="hover:underline"
            >
              {props.meeting.title || "(untitled)"}
            </Link>
          </CardTitle>
          <CardDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MeetingDateTime
              meetingId={props.meeting.id}
              date={props.meeting.date}
              time={props.meeting.time}
              timezone={props.meeting.body.timezone}
              onSaved={props.onSaved}
            />
            <Duration durationSecs={props.meeting.duration_secs} />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HoverCard>
            <HoverCardTrigger
              as="span"
              class="text-muted-foreground cursor-default text-sm underline decoration-dotted underline-offset-4"
            >
              {props.meeting.body.name}
            </HoverCardTrigger>
            <HoverCardPortal>
              <HoverCardContent>
                <div class="flex flex-col gap-1">
                  <p class="font-semibold">{props.meeting.body.name}</p>
                  <p class="text-muted-foreground text-sm">
                    {props.meeting.body.jurisdiction.name}
                    <Show when={props.meeting.body.jurisdiction.state}>
                      {(state) => <>, {state()}</>}
                    </Show>
                  </p>
                  <Link
                    to="/bodies/$id"
                    params={{ id: String(props.meeting.body.id) }}
                    class="text-sm font-medium hover:underline"
                  >
                    View body →
                  </Link>
                </div>
              </HoverCardContent>
            </HoverCardPortal>
          </HoverCard>
        </CardContent>
      </div>
    </Card>
  );
}
