# @open-minutes/datasets

The real, hand-verified data that seeds local and test databases and scores
the speech models. Nothing here ships to production.

[`test-data/`](test-data/) holds the jurisdictions, bodies (with their meeting
sources), people and golden meetings. Adding a body means adding rows there.
Each golden meeting is a directory of its metadata, its transcript
(`golden.psv`) and its chapters. The `transcript-cleanup` and
`people-records` skills in [`.claude/skills/`](../../.claude/skills/)
describe how to edit them.

`@open-minutes/datasets/audio` gets a golden meeting's audio and checks that
it's the audio its transcript was timed to.

A dataset is a named selection of that data, declared by a JSON spec in
[`specs/`](specs/): which meetings, which people, and where their voiceprints
come from. `@open-minutes/datasets/spec` reads and checks the specs. This
package doesn't touch a database, so packages that only read the data (like
`@open-minutes/audio`'s tests) don't depend on `@open-minutes/db`.
[`@open-minutes/seed`](../seed/README.md) seeds a database with a dataset.

## Transcript format

Golden transcripts are PSV: one event per line, `start_sec|event_type|event_data`,
with absolute `H:MM:SS.ss` timestamps.

```
start_sec|event_type|event_data
0:00:33.11|meta|{"begin_speaker":"identified:jennifer-wingard"}
0:00:33.11|text|All
0:00:33.35|text|right.
```

Each word is its own `text` line, so a re-transcription or a hand correction
shows up as a word-level diff. A `meta` line with `begin_speaker` starts a
new segment, labeled in one of three forms (see
[docs/speaker-identity.md](../../docs/speaker-identity.md)):

- `unlabeled`: no speaker information.
- `segmented:spk-<n>`: a voice the diarizer separated, local to this meeting.
- `identified:<slug>`: a person in `people.jsonl`, the same in every meeting.

When editing by hand, keep one word per line and keep timestamps absolute.
The full grammar is in [`src/psv.ts`](src/psv.ts). Why PSV and not JSON, CSV
or a binary format is in
[docs/research/golden-transcript-format.md](../../docs/research/golden-transcript-format.md).

## Checking and fixing

Golden meetings must follow the rules in
[`@open-minutes/core`](../core/README.md#rules).

```sh
pnpm datasets:check [file ...]   # report violations; errors fail it and the tests
pnpm datasets:fix [file ...]     # apply every rule's fix in place
```

`--help` describes the options. A Claude Code hook in
[`.claude/settings.json`](../../.claude/settings.json) runs the check after
every edit, so an agent sees a problem on the turn it makes it.
