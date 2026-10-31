# Contributing to Open Minutes

For developers.
Words like _body_, _meeting_, _segment_ have specific meanings;
see [TERMINOLOGY.md](TERMINOLOGY.md) and use them in code, comments and commits.

## Architecture

```
YouTube / akleg.gov ──▶ audio (transcribe / diarize) ──▶ Postgres ◀── web (Cloudflare Workers)
```

Open Minutes finds a body's recorded meetings on the site that publishes them,
gets each meeting's audio, turns it into a transcript attributed to the people
speaking, and stores it in Postgres, where a public website lets anyone read
and search it. Nothing yet runs a meeting through all of these stages
end to end; that orchestration is still to be built.

The code is a pnpm workspace, roughly in layers from bottom to top:

- **Shared domain** (`core`): types and pure logic every other package uses,
  with no database, I/O, or heavy dependencies.
- **Storage** (`db`): the Postgres schema, migrations and database tooling.
- **Sources** (`youtube`, `akleg`, with `ytdlp` underneath): adapters for how
  to get metadata, recordings, etc from an upstream site.
- **Audio** (`blobstore`, `meeting-audio`, `codecs`, `audio`): store, cache and
  decode meeting audio, then transcribe and diarize it with local models.
- **Datums and datasets** (`datasets`, `seed`, `glossary`): hand-verified real
  meetings, people and bodies that seed local and test databases and score the
  speech models.
- **Website** (`web`): the public transcript browser.

Postgres runs in Docker locally and on [Neon](https://neon.tech) in
production. Jurisdictions contain bodies; bodies hold meetings; a meeting's
transcript is a sequence of segments, each spoken by a person, who carries a
voiceprint so they can be recognized in later meetings.

## Getting started

You need [Vite+](https://viteplus.dev) and Docker with Compose. Vite+ provides
`node` and `pnpm` at the versions `devEngines` in `package.json` pins, and runs
the formatter, linter and tests: `curl -fsSL https://vite.plus | bash`

Then (new shell):

```sh
pnpm install
pnpm dev       # http://localhost:3000
```

`pnpm dev` starts Postgres, sets up a seeded database for your git branch, and
starts the website. Local development needs no configuration; optional
settings are described in [`.env.example`](.env.example).

Before committing, run `pnpm check`, which typechecks, lints, checks
formatting and runs the fast tests.

## Guides

- [The database](docs/contributing/db.md): resetting it, changing the schema,
  databases in tests, and reaching production.
- [Testing](docs/contributing/testing.md): the kinds of tests and how to run
  the slow ones.
- [Recordings and scouts](docs/contributing/recordings.md): how recordings
  are found on the sites that publish them, judged, and their audio stored.
- [Meeting audio](docs/contributing/audio.md): how a meeting's audio gets from
  where it's published to the speech models.
- [Deploying](docs/contributing/deploy.md): how production is deployed and why
  we only roll forward.

## Documentation

Anything written in files must only describe how things work now, not how they got that way.
When a change makes a doc wrong, fix the doc in the same commit.
History and narrative belongs in commit messages and in messages to the user,
but the files in the repo must be understandable without needing the
conext of the entire git history.

## Commits

- Short, lowercase, imperative subject lines, usually with a type prefix
  (`feat:`, `fix:`, `docs:`, ...) or an area prefix (`web:`, `audio:`, ...).
- For anything non-trivial, add a body that explains _why_, and what a
  reviewer should know.
- Never commit generated or downloaded files; `.gitignore` lists them.
