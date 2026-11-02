import { useLocation, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import { z } from "zod";
import { formatMeetingDate } from "@open-minutes/core/meeting-date";
import {
  BuildingIcon,
  CalendarIcon,
  CloseIcon,
  PersonIcon,
  SearchIcon,
} from "~/components/icons";
import { BodyThumbnail } from "~/features/bodies/body-thumbnail";
import { MeetingThumbnail } from "~/features/meetings/meeting-thumbnail";
import { PersonAvatar } from "~/features/people/person-avatar";
import { cx } from "~/lib/cva";
import { db } from "~/server/db";
import { type EntityMatch, searchPreview } from ".";

const fetchPreview = createServerFn({ method: "GET" })
  .validator(z.string())
  .handler(({ data }) => searchPreview(db(), data));

/** One row of the open bar's list: a page to go to, or a query to search. */
type Option =
  | { kind: "entity"; entity: EntityMatch }
  | { kind: "query"; query: string };

const LISTBOX_ID = "search-bar-options";
const optionId = (index: number) => `search-bar-option-${index}`;

/** Shortest query that gets suggestions. */
const MIN_SUGGEST_LENGTH = 2;
/** Typing pause before fetching suggestions, in ms. */
const DEBOUNCE_MS = 150;
/** Matches the panel's transition duration. */
const SLIDE_MS = 200;
/** Widest the open panel gets, in px. */
const PANEL_MAX_WIDTH = 640;
/** Gap between the open panel and the viewport's edges, in px. */
const PANEL_INSET = 8;

type Box = { top: number; left: number; width: number };

/**
 * The site-wide search box. It sits at the right of the header; opening it
 * slides it to the top center over a dimmed page. As you type it lists the
 * people, meetings and bodies the query seems to name, which link straight to
 * their pages, then suggested queries. Arrow keys move through the list and
 * Enter picks the highlighted row, or searches when none is. Closing (Escape
 * or a click outside) leaves the page as it was and keeps the query.
 */
export function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = createSignal("");
  // "closed": only the header trigger shows. "opening" and "closing" render
  // the panel over the trigger; "open" renders it centered.
  const [phase, setPhase] = createSignal<
    "closed" | "opening" | "open" | "closing"
  >("closed");
  const [box, setBox] = createSignal<Box>({ top: 0, left: 0, width: 0 });
  let trigger!: HTMLButtonElement;
  let input: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  // The search page's query is the bar's query.
  createEffect(
    on(
      () => location().search as { q?: unknown },
      (search) => {
        if (location().pathname === "/search" && typeof search.q === "string")
          setQuery(search.q);
      },
    ),
  );

  const [debounced, setDebounced] = createSignal("");
  createEffect(() => {
    const q = query().trim();
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    onCleanup(() => clearTimeout(t));
  });
  const [preview] = createResource(
    () => {
      const q = debounced();
      return phase() !== "closed" && q.length >= MIN_SUGGEST_LENGTH && q;
    },
    (q) => fetchPreview({ data: q }),
  );
  /** The highlighted row of `options()`, or -1 for none. */
  const [active, setActive] = createSignal(-1);

  function triggerBox(): Box {
    const r = trigger.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width };
  }

  function centeredBox(): Box {
    const width = Math.min(
      PANEL_MAX_WIDTH,
      window.innerWidth - 2 * PANEL_INSET,
    );
    return {
      top: PANEL_INSET,
      left: (window.innerWidth - width) / 2,
      width,
    };
  }

  function open() {
    if (phase() === "open" || phase() === "opening") return;
    clearTimeout(timer);
    setBox(triggerBox());
    setPhase("opening");
    // Let the panel paint at the trigger's box, then slide it to center.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (phase() !== "opening") return;
        setBox(centeredBox());
        setPhase("open");
      }),
    );
  }

  function close() {
    if (phase() === "closed" || phase() === "closing") return;
    setBox(triggerBox());
    setPhase("closing");
    timer = setTimeout(() => {
      setPhase("closed");
      trigger.focus({ preventScroll: true });
    }, SLIDE_MS);
  }

  function submit(q: string) {
    setQuery(q);
    close();
    if (q.trim()) void navigate({ to: "/search", search: { q: q.trim() } });
  }

  function pick(option: Option) {
    if (option.kind === "query") return submit(option.query);
    close();
    const { entity } = option;
    const params = { id: String(entity.id) };
    if (entity.kind === "person") void navigate({ to: "/people/$id", params });
    else if (entity.kind === "meeting")
      void navigate({ to: "/meetings/$id", params });
    else void navigate({ to: "/bodies/$id", params });
  }

  createEffect(() => {
    if (phase() !== "open") return;
    input?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onResize = () => setBox(centeredBox());
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    });
  });

  const options = createMemo((): Option[] => {
    const q = query().trim();
    const latest = preview.latest;
    if (q.length < MIN_SUGGEST_LENGTH || q !== debounced() || !latest)
      return [];
    return [
      ...latest.entities.map((entity): Option => ({ kind: "entity", entity })),
      ...latest.queries.map((query): Option => ({ kind: "query", query })),
    ];
  });
  // A new list starts with nothing highlighted, so Enter searches.
  createEffect(on(options, () => setActive(-1)));

  function onInputKey(event: KeyboardEvent) {
    const count = options().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!count) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // -1 sits between the last row and the first, so the arrows can return
      // to no highlight.
      setActive((i) => ((i + 1 + step + count + 1) % (count + 1)) - 1);
    } else if (event.key === "Enter" && active() >= 0) {
      event.preventDefault();
      pick(options()[active()]!);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        onClick={open}
        class={cx(
          "border-input text-muted-foreground hover:bg-accent flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-2 text-sm sm:w-72 sm:px-3",
          phase() !== "closed" && "invisible",
        )}
      >
        <SearchIcon class="size-4 shrink-0" />
        <span
          class={cx("hidden truncate sm:inline", query() && "text-foreground")}
        >
          {query() || "Search"}
        </span>
      </button>
      <Show when={phase() !== "closed"}>
        <Portal>
          <div
            aria-hidden="true"
            onClick={close}
            class={cx(
              "fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none",
              phase() === "open" ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            class="fixed z-50 transition-[top,left,width] duration-200 ease-out motion-reduce:transition-none"
            style={{
              top: `${box().top}px`,
              left: `${box().left}px`,
              width: `${box().width}px`,
            }}
          >
            <form
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                submit(query());
              }}
              class={cx(
                "bg-background flex items-center gap-2 rounded-full border px-3 shadow-lg transition-[height] duration-200 motion-reduce:transition-none",
                phase() === "open" ? "h-11" : "h-8",
              )}
            >
              <SearchIcon class="text-muted-foreground size-4 shrink-0" />
              <input
                ref={input}
                name="q"
                type="text"
                autocomplete="off"
                role="combobox"
                aria-label="Search"
                aria-autocomplete="list"
                aria-expanded={options().length > 0}
                aria-controls={LISTBOX_ID}
                aria-activedescendant={
                  active() >= 0 ? optionId(active()) : undefined
                }
                placeholder="Search"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onInputKey}
                class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
              />
              <Show when={query()}>
                <button
                  type="button"
                  aria-label="Clear"
                  onClick={() => {
                    setQuery("");
                    input?.focus();
                  }}
                  class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full"
                >
                  <CloseIcon class="size-4" />
                </button>
              </Show>
            </form>
            <Show when={phase() === "open" && options().length > 0}>
              <ul
                id={LISTBOX_ID}
                role="listbox"
                aria-label="Suggestions"
                class="bg-popover text-popover-foreground mt-2 overflow-hidden rounded-xl border py-2 shadow-lg"
              >
                <For each={options()}>
                  {(option, index) => (
                    <li
                      id={optionId(index())}
                      role="option"
                      aria-selected={active() === index()}
                      // Keep focus in the input, so typing carries on.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(index())}
                      onClick={() => pick(option)}
                      class={cx(
                        "flex cursor-pointer items-center gap-3 px-4 py-2",
                        active() === index() && "bg-accent",
                        option.kind === "query" &&
                          index() > 0 &&
                          options()[index() - 1]!.kind === "entity" &&
                          "mt-2 border-t pt-3",
                      )}
                    >
                      <Switch>
                        <Match when={option.kind === "entity" && option.entity}>
                          {(entity) => <EntityRow entity={entity()} />}
                        </Match>
                        <Match when={option.kind === "query" && option.query}>
                          {(suggestion) => (
                            <>
                              <SearchIcon class="text-muted-foreground size-4 shrink-0" />
                              <SuggestionText
                                suggestion={suggestion()}
                                query={query()}
                              />
                            </>
                          )}
                        </Match>
                      </Switch>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}

/** A suggestion with the part past what was typed in bold. */
function SuggestionText(props: { suggestion: string; query: string }) {
  const typed = () => {
    const q = props.query.trim().toLowerCase();
    return props.suggestion.startsWith(q) ? q.length : 0;
  };
  return (
    <span class="truncate">
      {props.suggestion.slice(0, typed())}
      <span class="font-semibold">{props.suggestion.slice(typed())}</span>
    </span>
  );
}

/** A person, meeting or body: its kind's icon, its name, a line about it, and its picture. */
function EntityRow(props: { entity: EntityMatch }) {
  const row = createMemo(
    (): {
      icon: JSX.Element;
      title: string;
      detail: string;
      picture: JSX.Element;
    } => {
      const e = props.entity;
      switch (e.kind) {
        case "person":
          return {
            icon: <PersonIcon class="size-4" />,
            title: e.name,
            detail: e.bio ?? "Person",
            picture: <PersonAvatar person={e} class="size-9" />,
          };
        case "meeting":
          return {
            icon: <CalendarIcon class="size-4" />,
            title: e.title || "Untitled meeting",
            detail: [
              e.bodies.map((b) => b.name_short || b.name).join(", "),
              formatMeetingDate(e) ?? "Date unknown",
            ]
              .filter(Boolean)
              .join(" · "),
            picture: <MeetingThumbnail meeting={e} class="w-16" />,
          };
        case "body":
          return {
            icon: <BuildingIcon class="size-4" />,
            title: e.name,
            detail: e.jurisdiction || "Board or council",
            picture: <BodyThumbnail body={e} class="w-16" />,
          };
      }
    },
  );
  return (
    <>
      <span class="text-muted-foreground shrink-0">{row().icon}</span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate font-medium">{row().title}</span>
        <span class="text-muted-foreground truncate text-sm">
          {row().detail}
        </span>
      </span>
      {row().picture}
    </>
  );
}
