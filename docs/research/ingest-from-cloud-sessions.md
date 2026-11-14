# Ingesting meetings from a cloud session

What stops a Claude Code cloud session from turning a scouted recording into a
meeting in production, and the proposed fix. Findings are from 2026-11-14.

## What a cloud session can and can't do

| Action                                                  | From a cloud session                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Read the blob store (public R2 bucket)                  | Works                                                                                                                            |
| Read the nightly DuckDB export                          | Works                                                                                                                            |
| YouTube metadata (`mweb`, `web_embedded`)               | Works                                                                                                                            |
| YouTube audio with yt-dlp                               | Fails: "Sign in to confirm you're not a bot", or 403 from `googlevideo.com` (see [youtube-on-servers.md](youtube-on-servers.md)) |
| WARP or Tor                                             | Impossible: the only egress is an HTTPS proxy                                                                                    |
| Dispatch a workflow (`workflow_dispatch`)               | Fails: the GitHub integration gets `403 Resource not accessible by integration`                                                  |
| Open an issue, post and edit issue comments, add labels | Works, as the repository owner, so `author_association` is `OWNER`                                                               |
| Push to its own branch                                  | Works                                                                                                                            |
| Connect to production Postgres                          | No credentials. The proxy can add an HTTP header to requests for a host, which can't carry a Postgres password                   |
| Transcribe and diarize                                  | Works: 4 CPUs and 15 GB, about the size of a GitHub `ubuntu-latest` runner                                                       |

So a session has no way to get YouTube audio into the blob store, to write a
meeting to production, or to read production for the cleanup after. Both are possible in CI, which has the blob
store's keys, WARP and Tor, and production's credentials. A session can start
CI work in one way: an issue comment, the way
[changesets](../../packages/changeset-review/README.md) reach production.

## Blocker 1: audio for chosen recordings

Scout stores audio for at most 20 recordings an hour, newest first, so a
recording from 2023 can wait days behind newer ones, or never be reached if it
failed three times.

### Options

1. **An issue that asks CI for recordings' audio (proposed).** A workflow on
   `issue_comment`, gated as `changeset-check.yml` is (author is `OWNER`,
   `MEMBER` or `COLLABORATOR`; the comment starts with a marker), stores the
   audio of the recordings the comment lists, with scout's code from
   `production`, in the `object-store-writer` environment, through WARP or
   Tor. It comments what it stored and what failed. Fetching public audio into
   a public bucket needs no review, so there is no approval step.
2. **A priority column on `recordings` that scout serves first.** Setting it
   needs a changeset, so every request waits for review and then for the next
   hourly run. Slower for no gain in safety.
3. **Give the Claude GitHub App `actions: write`.** The repository doesn't
   control the app's permissions. Even with them, `fetch-youtube-audio.yml`
   only publishes artifacts for a day and stores nothing.
4. **Reach YouTube from the container**: cookies, or a paid residential proxy
   added as an allowed host with a credential. Cookies don't stop the 403s,
   which come from the container's address changing between requests. A
   residential proxy adds a paid outside service and puts a Google account or
   proxy credential at risk. Not worth it while CI can fetch.

## Blocker 2: writing a meeting to production

A new meeting needs its audio transcribed, diarized and aligned, then a
`meetings` row with its `meeting_bodies` and `segments`. Production changes
reach it only from CI.

### Options

1. **CI ingests the recording (proposed).** A new `pnpm ingest <site>:<id>`
   reads the audio from the blob store and runs the pipeline
   [#137](https://github.com/NickCrews/open-minutes/issues/137) lays out:
   speech runs from `detectVoiceActivity`, voiceprints of sliding windows
   over them (`slidingWindows`, `embedSpans`), speaker turns from clustering
   those windows (`clusterVoices`, not built yet), words from
   `transcribeAudio`, and segments from `alignSpeakers`. It matches each
   speaker's `centroid` against `people`'s voiceprints, and inserts the
   meeting, with its title and date from the recording, bodies from
   `recording_bodies`, and segments labelled with a known person where the
   match is confident, else a speaker number. The same issue that asks for
   audio asks for ingest; the job comments the meeting's id and link. The
   session then cleans the meeting up through changesets, with the
   `transcript-cleanup` and `people-records` skills, which already cover
   meetings no human has touched.

   A raw meeting goes to production without review, as a raw recording does
   from scout: it only adds rows. If that should be reviewed, the job can wait for a
   `ingest:approved` label from an admin, as `changeset-apply.yml` does.

2. **The session ingests; CI saves its result.** The session transcribes in
   its own container, pushes the result (a golden-style PSV and
   `meeting.json`) to its branch, and an issue names the branch, path and
   commit. After an approval label, CI on `main` reads that commit and
   inserts it. This costs no CI minutes and lets the session redo a step
   cheaply, but it adds a second way to write a meeting, a file format CI has
   to trust, and an approval for every meeting. The session still needs
   Blocker 1 solved for the audio. A 3-hour transcript (~30,000 words) is
   too big for an issue comment (65,536 characters), which is why it goes
   through a branch.

3. **Production credentials in the session.** The proxy's credential
   injection holds an HTTP header for one host. Postgres isn't HTTP, and
   Neon's HTTP SQL endpoint takes the password in a `Neon-Connection-String`
   header, a name the credential form doesn't accept. It would also give an
   agent unreviewed write access to all of production. Rejected.
4. **A changeset that inserts the meeting.** A session can already propose
   changesets, which reach production after an admin's approval. But the
   `changeset` role may insert `segments` and not `meetings`,
   `meeting_bodies` or `people`, and CI reads a version's SQL from one issue
   comment, at most 65,536 characters. `gbos-2026-03-23` has 25,791 words,
   whose `golden.psv` is 573 KB, so one meeting would take ten or more
   changesets, each reviewed and approved. The review would be of 25,000
   inserted words, which nobody can check by reading. Granting the inserts
   and splitting a meeting across changesets would work with no new
   workflow, but the session would still need option 1's audio, and
   approving would be busywork. Changesets stay the way to clean a meeting
   up once it exists.

### Running time

Timed on `gbos-2026-03-23` (9,970 s of audio) in a cloud container with 4
CPUs and 15 GB, about the size of an `ubuntu-latest` runner (4 CPUs, 16 GB):

| Step                                          | Time  | × real time | Peak memory           |
| --------------------------------------------- | ----- | ----------- | --------------------- |
| `detectVoiceActivity`                         | 40 s  | 0.004       | 1.3 GB                |
| `embedSpans` on 9,757 windows (1.5 s, 0.75 s) | 145 s | 0.015       | 2.0 GB                |
| `transcribeAudio`                             | 706 s | 0.071       | 11.3 GB               |
| `diarizeAudio` (sherpa, one pass)             | -     | -           | killed: out of memory |

So the steps that exist take about 15 minutes for a 3-hour meeting, well
inside a job's 6-hour limit. sherpa's diarizer can't take a whole meeting in
one pass on a machine this size, which is one more reason for #137's
clustering of window voiceprints. Transcription's 11.3 GB is close to a
runner's 16 GB; transcribing a meeting in parts would leave more room.

## Blocker 3: cleaning up the meeting

The `transcript-cleanup` skill reads the meeting and checks changesets with
`--db prod`, which a session can't connect to. CI's `changeset-check.yml`
checks every proposed version against production anyway, so the session only
needs a close copy to write the changeset against.

### Options

1. **A local database built from the DuckDB export (proposed).** The nightly
   export has every table the cleanup reads, with each segment's `words`,
   people's voiceprints, and production's ids, so `om.*` calls and
   `UPDATE ... WHERE id = ...` written against the copy mean the same thing
   in production. A new `pnpm db up --from-export` would load it into the
   branch's local database after migrating. It is up to a day old. The CI
   check catches the difference, and an ingest job can run
   `export-duckdb.yml` after it saves a meeting, so the new meeting is in
   the export within minutes.
2. **A Neon branch per session.** [db.md](../contributing/db.md#neon-branches)
   describes one, made with `neonctl` and a `NEON_API_KEY`. The key could be
   given to the session as a credential for `console.neon.tech`, and the
   branch reached over WebSockets on port 443 with `@neondatabase/serverless`.
   But a project-scoped key can also fetch production's connection string,
   which is the unreviewed write access option 3 above rejects.

## Proposal

One issue-driven workflow, `ingest.yml`, for both blockers:

1. A session (or a person) opens an issue labelled `ingest` whose comment
   starts `<!-- ingest:request -->` and lists recordings, one
   `<site>:<external_id>` per line. The workflow checks each against the
   pattern its site allows and reads them with no shell interpolation.
2. For each recording, the job stores its audio if the blob store doesn't
   have it, as scout does, then runs `pnpm ingest` on it against production,
   skipping one that already has a meeting. One job per recording, so a
   3-hour meeting has the job's whole time limit to itself.
3. It runs `export-duckdb.yml`, then comments, per recording, the meeting's
   id and website link, or the error.
4. The session follows the issue with the GitHub tools, loads the new export
   with `pnpm db up --from-export`, and proposes changesets to name speakers
   and fix words.

What to build:

- `clusterVoices` and the rest of #137.
- `pnpm ingest` (a new package, or a command in `scout`), with tests against
  a fake blob store and a test database, as scout's are.
- `.github/workflows/ingest.yml`, gated and run from `production` as
  `scout.yml` is.
- `pnpm db up --from-export`.
- An `ingest` skill that tells a session how to request ingest, follow it,
  and go on to cleanup; and `transcript-cleanup` saying to use the export
  copy where `prod` can't be reached.
- The `ingest` label.

Later, scout can ingest each recording whose audio it stores, so nothing has
to be asked for; the issue stays for recordings someone wants first.
