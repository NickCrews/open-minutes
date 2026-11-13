// A page for reviewing a changeset's diff, the JSON that `pnpm changeset view
// --json` writes. It isn't linked from anywhere. The diff comes from a URL
// (`?url=`) or a dropped or chosen file, and is rendered in the browser; the
// page reads no database. See packages/changeset-view/README.md.
import { createFileRoute } from "@tanstack/solid-router";
import { createSignal, onMount, Show, type JSX } from "solid-js";
import {
  type ChangesetDiff,
  renderReport,
  STYLES,
} from "@open-minutes/changeset-view";
import clientScript from "@open-minutes/changeset-view/client.js?raw";

export const Route = createFileRoute("/changesets")({
  head: () => ({
    meta: [
      { title: "Changeset · Open Minutes" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    url: typeof search.url === "string" ? search.url : undefined,
  }),
  component: ChangesetPage,
});

function ChangesetPage(): JSX.Element {
  const search = Route.useSearch();
  const [error, setError] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal(false);
  let report!: HTMLDivElement;
  let urlInput!: HTMLInputElement;

  const show = (text: string) => {
    let diff: ChangesetDiff;
    try {
      diff = JSON.parse(text) as ChangesetDiff;
      if (!Array.isArray(diff.statements)) throw new Error("no statements");
    } catch (err) {
      setError(`Not a changeset diff: ${(err as Error).message}`);
      return;
    }
    setError(null);
    report.innerHTML = `<style>${STYLES}</style>${renderReport(diff)}`;
    const script = document.createElement("script");
    script.textContent = clientScript;
    report.append(script);
    setShown(true);
  };

  const load = async (url: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      show(await res.text());
    } catch (err) {
      setError(`Couldn't load ${url}: ${(err as Error).message}`);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (file) show(await file.text());
  };

  onMount(() => {
    if (search().url) void load(search().url!);
  });

  return (
    <div
      class="mx-auto max-w-6xl"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void readFile(e.dataTransfer?.files[0]);
      }}
    >
      <Show when={!shown()}>
        <h1 class="mb-2 text-2xl font-bold">Review a changeset</h1>
        <p class="text-muted-foreground mb-4">
          Drop the JSON that <code>pnpm changeset view --json</code> writes
          anywhere on this page, choose it, or load it from a URL.
        </p>
        <form
          class="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.value) void load(urlInput.value);
          }}
        >
          <input
            ref={urlInput}
            type="url"
            placeholder="https://.../diff.json"
            class="min-w-0 flex-1 rounded border px-2 py-1"
          />
          <button type="submit" class="rounded border px-3 py-1">
            Load
          </button>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void readFile(e.currentTarget.files?.[0])}
          />
        </form>
      </Show>
      <Show when={error()}>
        <p role="alert" class="mb-4 text-red-700 dark:text-red-400">
          {error()}
        </p>
      </Show>
      <div ref={report} />
    </div>
  );
}
