import { createFileRoute, useRouter } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getPersonById, updatePersonName } from "~/features/people";
import { Bio } from "~/features/people/bio";
import { createHiddenPlayer } from "~/features/meetings/hidden-player";
import {
  groupByMeeting,
  MeetingExcerptCard,
} from "~/features/meetings/meeting-excerpt-card";
import { assertCanEdit, canEdit } from "~/lib/permissions";
import { db } from "~/server/db";
import { z } from "zod";

const fetchPerson = createServerFn({ method: "GET" })
  .inputValidator(z.int().positive())
  .handler(({ data }) => getPersonById(db(), data));

/** Guarded on both sides of the wire by the same `canEdit` that hides the button. */
const savePersonName = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.int().positive(), name: z.string() }))
  .handler(({ data }) => {
    assertCanEdit("names");
    return updatePersonName(db(), data.id, data.name);
  });

export const Route = createFileRoute("/people_/$id")({
  loader: ({ params }) => fetchPerson({ data: Number(params.id) }),
  component: PersonPage,
});

function PersonPage() {
  const person = Route.useLoaderData();
  const router = useRouter();
  const player = createHiddenPlayer();
  const groups = createMemo(() => groupByMeeting(person().segments));
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const save = async (name: string) => {
    setSaving(true);
    try {
      await savePersonName({ data: { id: person().id, name } });
      await router.invalidate();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="mx-auto max-w-3xl">
      <Show
        when={editing()}
        fallback={
          <div class="mb-2 flex items-center gap-3">
            <h1 class="text-2xl font-bold">{person().name || "(unnamed)"}</h1>
            <Show when={canEdit()}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Show>
          </div>
        }
      >
        <form
          class="mb-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            void save(String(name ?? ""));
          }}
        >
          <TextField
            name="name"
            defaultValue={person().name ?? ""}
            class="flex-1"
          >
            <TextFieldInput
              type="text"
              placeholder="Person's name"
              autofocus
              class="text-2xl font-bold md:text-2xl"
            />
          </TextField>
          <Button type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving()}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      </Show>
      <Bio personId={person().id} bio={person().bio} />
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Meetings</h2>
      <div class="flex flex-col gap-4">
        <For
          each={groups()}
          fallback={<p class="text-muted-foreground">No segments yet.</p>}
        >
          {(group) => (
            <MeetingExcerptCard
              meeting={group.meeting}
              hits={group.hits}
              noun={["segment", "segments"]}
              player={player}
              // Nothing to choose between, so skip the click.
              defaultExpanded={groups().length === 1}
            />
          )}
        </For>
      </div>
      <div
        ref={player.setHost}
        aria-hidden="true"
        class="pointer-events-none fixed right-0 bottom-0 h-px w-px overflow-hidden opacity-0"
      />
    </div>
  );
}
