import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { Button } from "~/components/button";
import { TextField, TextFieldInput } from "~/components/text-field";
import { updateMeetingDate } from "~/features/meetings";
import { formatMeetingDate, formatZoneAbbreviation } from "~/lib/format";
import {
  parseMeetingDate,
  parseMeetingTime,
} from "@open-minutes/core/meeting-date";
import { assertCanEdit, canEdit } from "~/lib/permissions";
import { db } from "~/server/db";

/**
 * Dates and times are entered by hand as the wall clock read in the body's own
 * timezone — the form on the agenda, and the form they're stored in (ADR 0003),
 * so nothing is converted on the way in. The time is optional: often the day is
 * all anyone knows, and leaving it blank stores "time unknown" rather than a
 * made-up midnight. Clearing the date clears the time with it.
 *
 * Guarded on both sides of the wire by the same `canEdit` that hides the button.
 */
const saveMeetingDate = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number; date: string; time: string }) => input)
  .handler(async ({ data }) => {
    assertCanEdit("meeting dates");
    if (!data.date)
      return updateMeetingDate(db(), data.id, { date: null, time: null });
    const date = parseMeetingDate(data.date);
    if (!date) throw new Error(`Unrecognized date: ${data.date}`);
    const time = data.time ? parseMeetingTime(data.time) : null;
    if (data.time && !time) throw new Error(`Unrecognized time: ${data.time}`);
    return updateMeetingDate(db(), data.id, { date, time });
  });

/**
 * When a meeting happened, in the body's timezone: the date, plus the time when
 * it's known. In development it doubles as an editor, since ingestion can't
 * derive either and someone has to read it off the video — that's also why the
 * unset state stays visible there instead of collapsing away: an unset date is
 * the thing you came to fix.
 *
 * Takes the fields it needs rather than a meeting row, so the list and detail
 * pages can share it despite selecting different columns.
 */
export function StartTime(props: {
  meetingId: number;
  date: string | null;
  time: string | null;
  timezone: string;
  /** Rendered before the date, but only when there is something to separate. */
  prefix?: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const save = async (date: string, time: string) => {
    setSaving(true);
    try {
      await saveMeetingDate({ data: { id: props.meetingId, date, time } });
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
        <Show when={props.date || canEdit()}>
          {props.prefix}
          {formatMeetingDate(props) ?? "Date unknown"}
          <Show when={canEdit()}>
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
          const form = new FormData(event.currentTarget);
          void save(
            String(form.get("date") ?? ""),
            String(form.get("time") ?? ""),
          );
        }}
      >
        {/* TextField is `w-full` by default, which in a flex row stretches the
            pickers across the whole container. They only ever hold a
            fixed-width "07/13/2026" and "06:30 PM", so pin them to that. */}
        <TextField name="date" class="w-40" defaultValue={props.date ?? ""}>
          <TextFieldInput type="date" autofocus class="h-8" />
        </TextField>
        <TextField
          name="time"
          class="w-32"
          defaultValue={props.time?.slice(0, 5) ?? ""}
        >
          <TextFieldInput
            type="time"
            class="h-8"
            aria-label="Time (optional)"
          />
        </TextField>
        <span class="text-muted-foreground text-xs">
          {/* Noon UTC is the small hours in the Americas, so it lands on the
              day being edited and past any 2 AM DST switch. */}
          {formatZoneAbbreviation(
            props.date ? new Date(`${props.date}T12:00:00Z`) : new Date(),
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
