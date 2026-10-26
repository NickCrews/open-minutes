# @open-minutes/core

Domain code shared by every other package, with no database, I/O, or heavy dependencies:
transcript and timeline types, transcript cleaning and speaker alignment, word
error rate, chapter rules, reading a meeting's date from its title and
transcript, the interfaces a meeting source implements, voice-embedding
constants, and `.env.local` loading.

## Meeting dates

A meeting's "when" is stored in two nullable columns on `meetings`, both read
as the wall clock in the meeting's `timezone` (eg `America/Anchorage`), the
way an agenda prints them:

| column | example        | null means         |
| ------ | -------------- | ------------------ |
| `date` | `"2026-06-15"` | the day's unknown  |
| `time` | `"19:30:00"`   | the time's unknown |

- A null `time` means "time unknown", never midnight. `00:00:00` is a real
  midnight. A time without a date is forbidden
  (`meetings_time_requires_date`).
- No offset or instant is stored. Titles, agendas and minutes all give wall
  clock times, so nothing is converted on the way in or out, and a date with
  no time has no instant to store. An instant, if ever needed, is
  `date + time` in `timezone`.
- Both are strings, never JS `Date`s, so neither the server's nor the
  browser's timezone can shift them.

Use [`@open-minutes/core/meeting-date`](src/meeting-date/) rather than
formatting these yourself:

- `formatMeetingDate({ date, time })` gives `"June 15, 2026 7:30 PM"`,
  `"June 15, 2026"` when the time is unknown, or `null` when the date is
  (callers choose the fallback, eg "Date unknown"). `formatDate`,
  `formatTimeOfDay` and `formatMonthYear` format the pieces.
- `parseMeetingDate` and `parseMeetingTime` validate input, and normalize
  `"HH:MM"` to `"HH:MM:SS"`.
- `compareMeetingsNewestFirst` sorts by date then time, unknown dates last
  and, within a day, unknown times after known ones. SQL's
  `ORDER BY date DESC, time DESC` puts nulls first; add `NULLS LAST` there.
- `resolveMeetingDateTime` reads a date and time from a meeting's title and
  the opening of its transcript, with warnings where they disagree.

Golden meetings' `meeting.json` may set `date` (`"YYYY-MM-DD"`) and `time`
(`"HH:MM"` or `"HH:MM:SS"`); left out means unknown.

Meetings in different timezones are compared by wall clock, not instant.
Every body so far is in `America/Anchorage`.

## Rules

[`src/rules/`](src/rules/) holds the rules a transcript, its chapters and its
meeting's metadata should follow, one per file. Some rules have a fix, which
rewrites a meeting to remove what the rule finds where the data alone says
what the right rewrite is, such as dropping a filler word.

The same rules serve two purposes:

- **Cleaning** the recognizer's verbatim output, by applying the fixes of the
  cleaning rules (filler words such as "um", stuttered words such as
  "the the").
- **Checking** the hand-edited golden meetings in
  [`@open-minutes/fixtures`](../fixtures/README.md). Goldens must already be
  clean, or transcription output would be scored against disfluencies it
  removed on purpose, so a golden that breaks a cleaning rule is an error.

To add a cleanup, write a rule with a fix and tests, register it as a cleaning
rule in [`src/rules/index.ts`](src/rules/index.ts) and
[`src/rules/clean.ts`](src/rules/clean.ts), then run `pnpm fixtures:fix` and
review the change to the goldens.
