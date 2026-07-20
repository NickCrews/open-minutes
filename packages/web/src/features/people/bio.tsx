import { createServerFn } from "@tanstack/solid-start";
import { createSignal, onCleanup, Show } from "solid-js";
import { updatePersonBio } from "~/features/people";
import { assertCanEdit, canEdit } from "~/lib/permissions";
import { db } from "~/server/db";

/** Guarded on both sides of the wire by the same `canEdit` that hides the editor. */
const savePersonBio = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number; bio: string }) => input)
  .handler(({ data }) => {
    assertCanEdit("bios");
    return updatePersonBio(db(), data.id, data.bio);
  });

/** How long the typing has to stop before we write. */
const AUTOSAVE_DELAY_MS = 3000;

/**
 * A person's background, editable in place where editing is allowed at all.
 *
 * There's no edit mode and no save button: the prose is the textarea, and it
 * writes itself once the typing stops. The only thing distinguishing it from
 * static text is a border on hover, so a page full of people reads as prose
 * rather than as a form.
 */
export function Bio(props: { personId: number; bio: string | null }) {
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The latest text not yet written, or undefined when there's nothing owed. */
  let unsaved: string | undefined;

  const flush = async () => {
    clearTimeout(timer);
    const bio = unsaved;
    if (bio === undefined) return;
    unsaved = undefined;
    setStatus("saving");
    // Deliberately no router.invalidate(): the loader would hand back the value
    // we just sent, and re-rendering a textarea someone may already be typing
    // into again is a worse trade than letting this page's copy stay ahead.
    await savePersonBio({ data: { id: props.personId, bio } });
    setStatus("saved");
  };

  const schedule = (value: string) => {
    unsaved = value;
    setStatus("idle");
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  };

  // Leaving the page mid-timer shouldn't drop the edit.
  onCleanup(() => void flush());

  /** Grow to fit, so the box is the length of the prose and never scrolls. */
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <Show
      when={canEdit()}
      fallback={
        <Show when={props.bio}>
          <p class="text-muted-foreground mb-6 px-2 py-1 whitespace-pre-wrap">
            {props.bio}
          </p>
        </Show>
      }
    >
      <div class="mb-6">
        <textarea
          ref={(el) => queueMicrotask(() => fit(el))}
          class="text-muted-foreground hover:border-input focus:border-ring w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 whitespace-pre-wrap outline-none"
          placeholder="Add a bio — role, affiliation, tenure…"
          rows={1}
          onInput={(event) => {
            fit(event.currentTarget);
            schedule(event.currentTarget.value);
          }}
          onBlur={() => void flush()}
        >
          {/* As children, not `value`: a browser ignores a `value` attribute on
              a textarea, so a server-rendered one would sit blank until
              hydration caught up. */}
          {props.bio ?? ""}
        </textarea>
        <Show when={status() !== "idle"}>
          <p class="text-muted-foreground px-2 text-xs">
            {status() === "saving" ? "Saving…" : "Saved"}
          </p>
        </Show>
      </div>
    </Show>
  );
}
