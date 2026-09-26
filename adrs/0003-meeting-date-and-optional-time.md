# ADR 0003: Store a meeting's date and optional time as local wall-clock values

Date: 2026-09-26
Status: Accepted

## Context

A meeting used to have a single `start_time timestamptz`: a UTC instant, rendered
back through the body's `timezone` for display. That can't say the most common
thing we actually know. For many meetings we have the **date** (from the video
title, the agenda, the minutes) but not the **time**. The only way to store "June
15, 2026" in an instant is to invent an hour — usually midnight — and the UI then
shows "June 15, 2026 12:00 AM" as if it were a fact. Worse, midnight _in which
zone?_ An invented UTC midnight is the previous evening in Anchorage.

## Decision

Replace `start_time` with two nullable columns on `meetings`:

| column | type   | meaning                                                       |
| ------ | ------ | ------------------------------------------------------------- |
| `date` | `date` | Calendar day the meeting happened, in the body's `timezone`.  |
| `time` | `time` | Wall-clock time it started, in the body's `timezone`, or null |

- **A null `time` means "time unknown"**, never midnight. A `00:00:00` time is a
  real, entered midnight.
- **`date` is nullable too**: ingestion can't derive a date yet (YouTube's
  publish/stream times don't reliably match when a body gavelled in), so rows
  exist before anyone supplies one.
- A check constraint (`meetings_time_requires_date`) forbids a time without a
  date.

### Timezone: store the local wall clock, not an instant

Both values are the **local wall-clock reading in the body's `timezone`** (eg
`America/Anchorage`) — exactly what's printed on an agenda. No offset is stored;
the body's zone is the context that gives them meaning. We chose this over
keeping an instant because:

- The sources we get dates from (titles, agendas, minutes, a human reading a
  video) all speak wall-clock time. Storing what they say means no conversion on
  the way in and none on the way out, so nothing can drift.
- A date alone has no instant at all. Converting "June 15" to UTC either shifts
  the day or needs an invented time — the problem we're fixing.
- Every display is in the body's zone anyway; nobody wants an Anchorage meeting
  shown in the reader's own zone.
- Should we ever need an instant (eg aligning with a video's stream start), it
  is recoverable exactly from `date + time + bodies.timezone`, with the usual
  caveat of the repeated hour on a DST fall-back date.

Drizzle maps both columns as **strings** (`"2026-06-15"`, `"19:30:00"`), not
`Date`s, so neither the server's nor the browser's zone can shift them.

### Helpers

`@open-minutes/core/meeting-date` owns the logic, for the pipeline and web alike:

- `formatMeetingDate({ date, time })` → `"June 15, 2026 7:30 PM"`, `"June 15,
2026"` when the time is unknown, or `null` when the date is (callers choose
  their fallback, eg "Date unknown").
- `formatDate`, `formatTimeOfDay`, `formatMonthYear` for the pieces.
- `parseMeetingDate` / `parseMeetingTime` to validate input (and normalize
  `"HH:MM"` to `"HH:MM:SS"`).
- `compareMeetingsNewestFirst` for client-side sorting: by date then time,
  unknown dates last and, within a day, unknown times after known ones.

The web app re-exports the formatters from `~/lib/format`.

### Data

`meeting.json` fixtures gain optional `date` (`"YYYY-MM-DD"`) and `time`
(`"HH:MM"` or `"HH:MM:SS"`) fields, validated on load and seeded as-is. Absent
means unknown.

The migration is split expand/contract: one adds `date`/`time` and backfills
them from `start_time` converted into each body's zone, the next drops
`start_time`.

## Alternatives considered

- **Keep `timestamptz` plus a `time_known boolean`.** Still forces an invented
  time into the instant, and every reader must remember to consult the flag.
- **A single `timestamp` (without zone) with nullable time semantics.** Can't
  express "no time" without a sentinel.
- **Store an instant for timed meetings and a date for the rest.** Two
  representations of one fact; sorting and display would need both paths.

## Consequences

- SQL ordering by `date DESC, time DESC` puts null dates (and, within a day,
  null times) first, as Postgres sorts nulls high; use
  `compareMeetingsNewestFirst` or `NULLS LAST` where that matters.
- Comparing meetings across bodies in different zones compares wall clocks, not
  instants. Every body so far is in `America/Anchorage`, and cross-zone ordering
  to the hour isn't something readers need.
