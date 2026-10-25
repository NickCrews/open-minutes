# Contributing to Open Minutes

How Open Minutes fits together and how to run it. For what the project is and
who it's for, see the [README](README.md). Words like _body_, _meeting_,
_segment_ and _person_ have specific meanings here; see
[TERMINOLOGY.md](TERMINOLOGY.md) and use them in code, comments and commits.

## How it fits together

```
YouTube / akleg.gov ──▶ audio (transcribe / diarize) ──▶ Postgres + pgvector ◀── web (Cloudflare Workers)
```

Open Minutes finds a body's recorded meetings on the site that publishes them,
gets each meeting's audio, turns it into a transcript attributed to the people
speaking, and stores it in Postgres, where a public website lets anyone read
and search it. Nothing yet runs a meeting through all of these stages
end to end; that orchestration is still to be built.

The code is a [pnpm](https://pnpm.io) workspace under [`packages/`](packages/),
roughly in layers:

- **Shared domain** (`core`): types and pure logic every other package uses,
  with no database or I/O.
- **Storage** (`db`): the Postgres schema, migrations and database tooling.
- **Sources** (`youtube`, `akleg`, with `ytdlp` underneath): list the meetings
  a site has published and fetch their metadata and audio.
- **Audio** (`blobstore`, `meeting-audio`, `codecs`, `audio`): store, cache and
  decode meeting audio, then transcribe and diarize it with local models.
- **Test data** (`fixtures`, `datasets`, `glossary`): hand-verified real
  meetings, people and bodies that seed local and test databases and score the
  speech models.
- **Website** (`web`): the public transcript browser.

Each package's README says what it does and how to work on it.

Postgres runs in Docker locally and on [Neon](https://neon.tech) in
production. Jurisdictions contain bodies; bodies hold meetings; a meeting's
transcript is a sequence of segments, each spoken by a person, who carries a
voiceprint so they can be recognized in later meetings.

Significant design decisions are recorded in [`adrs/`](adrs/).

## Getting started

You need Node 22, pnpm (the version is pinned in `package.json`;
`corepack enable` picks it up), and Docker with Compose. Then:

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
- [Meeting audio](docs/contributing/audio.md): how a meeting's audio gets from
  where it's published to the speech models.
- [Deploying](docs/contributing/deploy.md): how production is deployed and why
  we only roll forward.

## Architecture Decision Records

Each ADR is a numbered Markdown file in [`adrs/`](adrs/). Follow the format of
the existing ones, and commit an ADR alongside the change it describes.

## Commits

- Short, lowercase, imperative subject lines, usually with a type prefix
  (`feat:`, `fix:`, `docs:`, ...) or an area prefix (`web:`, `audio:`, ...).
- For anything non-trivial, add a body that explains _why_, and what a
  reviewer should know.
- Never commit generated or downloaded files; `.gitignore` lists them.
