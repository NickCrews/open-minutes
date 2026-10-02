# Meeting audio: use cases and requirements

What we need from meeting audio, and from wherever we keep it, before choosing
how to build it. Implementation choices are deliberately left open; where this
doc mentions one, it's an example or a measurement, not a decision.

Status: draft, 2026-10-02.

## Why this matters

Audio is the raw input to everything Open Minutes produces: transcripts,
diarization, voiceprints, and speaker recognition. Today we fetch it from
YouTube (via yt-dlp) each time something needs it, and keep it only in
untracked per-machine caches. That causes three problems:

- **YouTube is an unreliable source for automation.** From datacenter IPs
  (CI runners, cloud machines) audio downloads fail on YouTube's bot check.
  See [youtube-in-ci.md](youtube-in-ci.md).
- **We don't keep what we've processed.** If a video is taken down, edited or
  re-encoded, we can't reproduce a transcript or re-run a better model on it.
- **Things that should be simple are expensive or faked.** The dev dataset's
  voiceprints are placeholders because real ones would mean every contributor
  downloads every golden meeting from YouTube.

## Terms

- **Recording**: the audio of one meeting, as one file.
- **Golden meeting**: a meeting with a hand-verified transcript in
  `packages/fixtures/test-data/`, used by tests, benchmarks and seeded datasets.
- **Ingested meeting**: any meeting the pipeline has processed into the
  database.
- **Store**: wherever recordings live long-term, outside any one machine.
- **Cache**: a copy of recordings (or data derived from them) on one machine
  or CI runner.

## Use cases

### U1. Ingesting new meetings (daily)

Every day, find meetings published since the last run on each body's video
sources, and ingest each one: get its audio, transcribe, diarize, compute
voiceprints, recognize speakers, and commit it to the production database.

- Runs unattended on a schedule, so it must work wherever that schedule runs
  (likely a datacenter IP, unless we choose otherwise).
- Volume is small: a few meetings a week across current bodies, each 1–4 hours.
  Growing to more jurisdictions could make it tens a week.
- Processing is CPU-heavy (roughly an hour per 3-hour meeting today), so a run
  must survive interruption and resume without redoing finished work.
- The recording should be kept (U2), so this is the one place that has to
  reach YouTube.

### U2. Keeping and reprocessing what we've ingested

Keep the recording of every ingested meeting, so we can:

- re-run the pipeline when models or algorithms improve, over some or all
  meetings, without going back to YouTube;
- reproduce or debug any transcript from the exact audio it came from;
- survive a video being removed or changed on YouTube.

Each meeting in the database should point unambiguously at the exact
recording it was produced from.

### U3. Tests and benchmarks in CI

Tests, benchmarks, and seeded test databases need golden meetings' audio. In
CI this must be:

- **Quick.** On a typical run (no golden audio changed), getting audio ready
  should add well under a minute. The fast suite runs on every push.
- **Independent of YouTube**, and of any credentials beyond what a public
  fork's CI has.
- **Reproducible.** The same golden always yields the same samples, on any
  runner, so results only change when code or fixtures change.

### U4. Local development

- `pnpm dev` seeds a realistic dataset, including **real voiceprints** for the
  golden people, so speaker recognition can be exercised locally.
- A new contributor needs no YouTube access, no cookies, and no credentials
  to get going. A one-time download on first run is acceptable; minutes, not
  tens of minutes.
- After that, reseeding (e.g. after editing a golden transcript) should be
  fast and work offline.
- Slow tests and benchmarks run locally use the same audio as CI.

### U5. Adding or updating a golden meeting

A maintainer picks a meeting, gets its audio, hand-corrects its transcript
against that audio, and commits the golden. The recording must be added to
the store as part of that, by someone with write access.

- The golden's word timings must stay true to the stored recording. If the
  stored audio differs from what the golden was made from (re-encoding,
  trimming, a different download), that must be caught, not silently accepted.
- Replacing a golden's audio is rare but must be possible, and must
  invalidate anything derived from the old audio.

### U6. Voiceprints from golden data

Golden transcripts say who speaks when. From that plus the audio we derive
each golden person's voiceprint, for the dev dataset and the e2e recognition
tests.

- Derived from the recording on demand, rather than committed as a generated
  artifact that can drift from the audio, transcripts or embedding model.
  (Measured: embedding is ~60 ms per 8-second clip, and a voiceprint uses at
  most 3 clips, so the cost is getting the audio, not computing.)
- Must change when, and only when, its inputs change: the recording, the
  golden's speaker labels, or the embedding model.

### U7. Other contributors and forks

- Anyone can read golden audio. Only maintainers can write to the store.
- Someone without write access can still prepare a new golden locally and hand
  the audio to a maintainer.

### Not in scope (for now)

- Playing audio in the web app. It embeds YouTube's player.
- Serving audio publicly as a product feature.
- Ingesting from sources other than YouTube, though nothing here should assume
  YouTube beyond the ingest step.

## Requirements

### Identity and integrity

- **R1.** A recording is identified by its content, so any copy (store,
  cache, a file someone hands over) can be verified to be the right one.
- **R2.** A stored recording never changes. New audio is a new recording.
- **R3.** Fixtures and database rows refer to recordings by that identity
  only, not by location or by how they were obtained.
- **R4.** Anything derived from a recording (decoded audio, voiceprints,
  seeded databases) is invalidated when the recording or the code that derives
  it changes, and only then.

### Fidelity

- **R5.** Stored quality is good enough that models can't tell the
  difference: the pipeline's ASR, diarization and embeddings should score the
  same (within noise) on stored audio as on the original.
- **R6.** Timing is preserved exactly: sample 0 of the stored recording is
  sample 0 of the original, with no added or dropped samples, so golden word
  timings stay valid. This needs verifying on real audio, not assuming.
- **R7.** Turning a stored recording into model input is deterministic: same
  bytes in, same samples out, on every machine.

### Availability and performance

- **R8.** Reading golden audio needs no credentials and no YouTube.
- **R9.** CI, with no golden audio changed, readies its audio in well under a
  minute (target: seconds).
- **R10.** Locally, the first setup downloads and prepares golden audio in a
  few minutes at most; afterwards everything works offline.
- **R11.** Consumers that need only part of a recording (voiceprints need
  ~24 s per person) shouldn't have to pay for the whole thing, if that is what
  it takes to meet R9 and R10.

### Durability and cost

- **R12.** Recordings of ingested meetings are kept indefinitely.
- **R13.** Storage cost stays negligible as we grow. For scale: speech-quality
  Opus at 24 kbps mono is ~11 MB per hour, so 10,000 hours of meetings is
  ~108 GB, about $1.60/month at Cloudflare R2's price ($0.015/GB-month, free
  egress). Uncompressed 16 kHz WAV is ~10× that.
- **R14.** Reads (CI runs, contributors) shouldn't cost per download, or
  should cost little enough not to matter.
- **R15.** Nothing about audio lives in git beyond identities: no recordings,
  clips or LFS. Repository size stays independent of how much audio we have.

### Access

- **R16.** Writing to the store is limited to maintainers and to the scheduled
  ingest, using credentials that work unattended.
- **R17.** The store's public read endpoint is suitable for regular automated
  use (e.g. not a rate-limited dev-only URL).

### Operations

- **R18.** Every flow above is one command (or a step in an existing one),
  with progress on stderr and clear errors that say what to do next: e.g.
  "this golden has no stored audio; add it with …".
- **R19.** Local and CI caches are safe to delete at any time, and safe under
  concurrent use (parallel test workers).
- **R20.** It's possible to list what's in the store and find recordings that
  nothing refers to.

## Constraints and known facts

- YouTube blocks audio downloads from datacenter IPs without cookies, PO
  tokens or a residential egress; listing videos and fetching metadata are
  workable ([youtube-in-ci.md](youtube-in-ci.md)).
- GitHub: files over 100 MB are rejected, repos are best kept under ~1 GB, LFS
  has bandwidth quotas, Actions caches are capped at 10 GB per repo, and jobs
  at 6 hours.
- The pipeline's models take 16 kHz mono. YouTube's own audio is ~130 kbps
  stereo Opus at 48 kHz, far more than the models need.
- The web app already runs on Cloudflare, which makes R2 the obvious
  candidate store, but that's not settled.
- Measured in a cloud container (4 cores): decoding 3 hours of 24 kbps Opus to
  16 kHz PCM takes ~15 s in WebAssembly; reading a 3-hour 16 kHz WAV
  (~350 MB) into the embedding toolkit takes ~7 s.
- Golden set as of this writing: 6 meetings, ~15 hours. As 24 kbps Opus that's
  ~160 MB; as 16 kHz WAV, ~1.7 GB.

## Open questions

1. **Where does the daily ingest run?** GitHub Actions with cookies or a PO
   token, a residential machine, or something else. This decides how U1 gets
   past YouTube, and is the only flow that has to.
2. **What do we store for ingested meetings:** the speech-quality encode we
   process (small) or YouTube's original stream as well (~5× larger, lossless
   relative to the source)?
3. **How do we verify R5 and R6?** For example, a one-off comparison of word
   error rate, diarization and alignment on original vs stored audio for the
   goldens.
4. **What does CI cache:** recordings only, or also prepared model input?
   This trades cache size against preparation time (R9).
5. **Do we keep the ingest work directory's other artifacts** (raw
   transcription and diarization) alongside the recording, so reprocessing can
   restart from any stage?
6. **Retention and takedowns.** Are there recordings we'd be asked to remove,
   and what happens to transcripts if so? Public meeting recordings are
   generally public record, but the store is publicly readable.
7. **Backups.** Is one provider enough for R12, or do we want a second copy?

## Prior work

An exploratory prototype covered U3, U4 and U6: a content-addressed Opus store
on R2 with a local cache, WebAssembly decoding, and voiceprints recomputed on
seed. The measurements above come from it. It was not merged; it's a reference
point for this spec, not the plan of record.
