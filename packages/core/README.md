# @open-minutes/core

Domain code shared by every other package, with no database or heavy
dependencies: transcript types, transcript cleaning and speaker alignment, word
error rate, chapter rules, reading a meeting's date from its title and
transcript, the interfaces a meeting source implements, voice-embedding
constants, and `.env.local` loading (its only I/O).

## Rules

[`src/rules/`](src/rules/) holds the rules a transcript, its chapters and its
meeting's metadata should follow, one per file. Some rules have a fix, which
rewrites a meeting to remove what the rule finds where the data alone says
what the right rewrite is, such as dropping a filler word.

The same rules serve two purposes:

- **Cleaning** the recognizer's verbatim output, by applying the fixes of the
  cleaning rules (filler words such as "um", stuttered words such as
  "the the").
- **Checking** meetings: the golden meetings in
  [`@open-minutes/datasets`](../datasets/README.md), and any meeting in a
  database with `pnpm transcript check` (see
  [`@open-minutes/edit`](../edit/README.md)). Goldens must already be
  clean, or transcription output would be scored against disfluencies it
  removed on purpose, so a golden that breaks a cleaning rule is an error.

To add a cleanup, write a rule with a fix and tests, register it as a cleaning
rule in [`src/rules/index.ts`](src/rules/index.ts) and
[`src/rules/clean.ts`](src/rules/clean.ts), then run `pnpm transcript fix` on each golden
meeting in production, export them with `pnpm goldens export`, and review the
change to the goldens.
