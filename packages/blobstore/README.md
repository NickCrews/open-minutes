# @open-minutes/blobstore

The project's blob store: an S3-compatible bucket (Cloudflare R2), publicly
readable at `BLOB_STORE_PUBLIC_URL`, one top-level prefix per kind of file.
This package knows what the bucket holds and where, and reads files from it.
It uses only `fetch`, so the web app imports it too.

```ts
import { blobStore } from "@open-minutes/blobstore";

const store = blobStore(); // or blobStore("https://...")
const audio = store.youtube("9HoIM5INxpI").speechWebm;
audio.key; // "youtube/9HoIM5INxpI/speech.webm"
audio.url; // its public URL
await audio.get(); // its bytes, or null if it isn't stored
store.duckdbExport.url;
```

Each file is a `BlobFile` (`key`, `url`, `get`), reached by what it is rather
than by building its key:

- `youtube(id)`: a YouTube video's `infoJson`, `speechWebm` and `errorJson`,
  which the
  [`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
  workflow writes.
- `recording({ site, external_id })`: a recording's `speechWebm`, at
  `recordings/<site>/<external_id>/speech.webm`, which `pnpm scout run`
  writes (see
  [recordings.md](../../docs/contributing/recordings.md#the-harness)).
- `duckdbExport`: production's public data as one DuckDB file, which the
  [`export-duckdb`](../../.github/workflows/export-duckdb.yml) workflow
  writes nightly.

Those workflows and the scout harness write with the AWS CLI, so keep their
keys in step with this package.

`blobStore()` reads the `BLOB_STORE_PUBLIC_URL` environment variable where
there is an environment (Node, the web app's Worker), falling back to the
project's bucket. The browser has no environment, so the web app passes the
URL its server is configured with (`useBlobStore` in
`packages/web/src/lib/blob-store.ts`).
