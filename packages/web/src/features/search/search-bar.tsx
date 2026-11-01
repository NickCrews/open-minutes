import { useLocation, useNavigate } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { z } from "zod";
import { CloseIcon, SearchIcon } from "~/components/icons";
import { cx } from "~/lib/cva";
import { db } from "~/server/db";
import { suggestQueries } from ".";

const fetchSuggestions = createServerFn({ method: "GET" })
  .validator(z.string())
  .handler(({ data }) => suggestQueries(db(), data));

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
 * slides it to the top center over a dimmed page and lists suggested queries
 * as you type. Submitting goes to the search page. Closing (Escape or a click
 * outside) leaves the page as it was and keeps the query for next time.
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
  const [suggestions] = createResource(
    () => {
      const q = debounced();
      return phase() !== "closed" && q.length >= MIN_SUGGEST_LENGTH && q;
    },
    (q) => fetchSuggestions({ data: q }),
  );

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

  const shown = () => {
    const q = query().trim();
    return q.length >= MIN_SUGGEST_LENGTH && q === debounced()
      ? (suggestions.latest ?? [])
      : [];
  };

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
          {query() || "Search transcripts"}
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
                aria-label="Search transcripts"
                placeholder="Search transcripts"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
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
            <Show when={phase() === "open" && shown().length > 0}>
              <ul class="bg-popover text-popover-foreground mt-2 overflow-hidden rounded-xl border py-2 shadow-lg">
                <For each={shown()}>
                  {(suggestion) => (
                    <li>
                      <button
                        type="button"
                        onClick={() => submit(suggestion)}
                        class="hover:bg-accent flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left"
                      >
                        <SearchIcon class="text-muted-foreground size-4 shrink-0" />
                        <SuggestionText
                          suggestion={suggestion}
                          query={query()}
                        />
                      </button>
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
