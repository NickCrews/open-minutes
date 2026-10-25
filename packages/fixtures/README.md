# @open-minutes/fixtures

The real, hand-verified data that seeds local and test databases and scores
the speech models. Nothing here ships to production.

[`test-data/`](test-data/) holds the jurisdictions, bodies (with their meeting
sources), people and golden meetings. Adding a body means adding rows there.
Each golden meeting is a directory of its metadata, its transcript (in the
format of [ADR 0001](../../adrs/0001-psv-golden-transcript-format.md)) and
its chapters. The `transcript-cleanup` and `people-records` skills in
[`.claude/skills/`](../../.claude/skills/) describe how to edit them.

`@open-minutes/fixtures/audio` gets a golden meeting's audio and checks that
it's the audio its transcript was timed to.

## Checking and fixing

Golden meetings must follow the rules in
[`@open-minutes/core`](../core/README.md#rules).

```sh
pnpm fixtures:check [file ...]   # report violations; errors fail it and the tests
pnpm fixtures:fix [file ...]     # apply every rule's fix in place
```

`--help` describes the options. A Claude Code hook in
[`.claude/settings.json`](../../.claude/settings.json) runs the check after
every edit, so an agent sees a problem on the turn it makes it.
