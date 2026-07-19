import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { getMeetingById, updateMeetingStartTime } from "~/features/meetings";
import {
  formatMeetingTime,
  formatZoneAbbreviation,
  toZonedInputValue,
  zonedInputValueToDate,
} from "~/lib/format";
import { db } from "~/server/db";

/**
 * Start times are entered by hand, in the body's own timezone — the wall-clock
 * time on the agenda is the only form anyone reads off the video. The client
 * sends that wall time and nothing else; the zone to read it in comes from the
 * body on this side, so the stored instant can't disagree with the zone the
 * page will render it back in.
 *
 * Development only on both sides of the wire, and by the same import.meta.env.DEV
 * that hides the button — Vite folds it to a constant in each bundle, so a
 * production build ships an endpoint that can only throw rather than a hidden
 * button with a live endpoint behind it. There's no auth here yet to do
 * anything better.
 */
const saveMeetingStartTime = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number; localTime: string }) => input)
  .handler(async ({ data }) => {
    if (!import.meta.env.DEV)
      throw new Error("Editing meeting times is a development-only affordance");
    if (!data.localTime) return updateMeetingStartTime(db(), data.id, null);
    const { body } = await getMeetingById(db(), data.id);
    const start = zonedInputValueToDate(data.localTime, body.timezone);
    if (!start) throw new Error(`Unrecognized start time: ${data.localTime}`);
    return updateMeetingStartTime(db(), data.id, start);
  });

/**
 * When a meeting started, shown in the body's timezone. In development it
 * doubles as an editor, since ingestion can't derive a start time and someone
 * has to read it off the video — that's also why the unset state stays visible
 * there instead of collapsing away: an unset time is the thing you came to fix.
 *
 * Takes the three fields it needs rather than a meeting row, so the list and
 * detail pages can share it despite selecting different columns.
 */
export function StartTime(props: {
  meetingId: number;
  startTime: Date | null;
  timezone: string;
  /** Rendered before the time, but only when there is something to separate. */
  prefix?: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const save = async (localTime: string) => {
    setSaving(true);
    try {
      await saveMeetingStartTime({
        data: { id: props.meetingId, localTime },
      });
      props.onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show
      when={editing()}
      fallback={
        <Show when={props.startTime || import.meta.env.DEV}>
          {props.prefix}
          <Show when={props.startTime} fallback={<>Date unknown</>}>
            {(at) => <>{formatMeetingTime(at(), props.timezone)}</>}
          </Show>
          <Show when={import.meta.env.DEV}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="ml-2 cursor-pointer text-xs underline decoration-dotted underline-offset-4"
            >
              edit
            </button>
          </Show>
        </Show>
      }
    >
      <form
        class="mt-1 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("start_time");
          void save(String(value ?? ""));
        }}
      >
        {/* TextField is `w-full` by default, which in a flex row stretches the
            date picker across the whole container. It only ever holds a
            fixed-width "07/13/2026, 06:30 PM", so pin it to that. */}
        <TextField
          name="start_time"
          class="w-56"
          defaultValue={
            props.startTime
              ? toZonedInputValue(props.startTime, props.timezone)
              : ""
          }
        >
          <TextFieldInput type="datetime-local" autofocus class="h-8" />
        </TextField>
        <span class="text-muted-foreground text-xs">
          {formatZoneAbbreviation(
            props.startTime ?? new Date(),
            props.timezone,
          )}
        </span>
        <Button type="submit" size="sm" disabled={saving()}>
          {saving() ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving()}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </form>
    </Show>
  );
}
