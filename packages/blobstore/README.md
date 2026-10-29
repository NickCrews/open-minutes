# @open-minutes/blobstore

The project's blob store: an S3-compatible bucket (Cloudflare R2), publicly
readable at `BLOB_STORE_PUBLIC_URL`, one top-level prefix per kind of file.
This package knows what the bucket holds and where, reads files from it, and
writes them given the bucket's keys. It uses only `fetch` (writes are signed
by [aws4fetch](https://github.com/mhart/aws4fetch)), so the web app imports it
too.

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

- `youtube(id)`: a YouTube video's `metadataJson` (its `RecordingMetadata`)
  and `speechWebm`, which `storedYoutube` in
  [`@open-minutes/meeting-audio`](../meeting-audio/README.md) makes and
  stores.
- `duckdbExport`: production's public data as one DuckDB file, which the
  [`export-duckdb`](../../.github/workflows/export-duckdb.yml) workflow
  writes nightly.

The export-duckdb workflow writes with the AWS CLI, so keep its key in step
with this package.

`blobStoreWriterFromEnv(process.env)` writes files, given the keys in
`BLOB_STORE_ENDPOINT`, `BLOB_STORE_BUCKET`, `BLOB_STORE_ACCESS_KEY_ID` and
`BLOB_STORE_SECRET_ACCESS_KEY` (see `.env.example`); without them it returns
null.

```ts
const writer = blobStoreWriterFromEnv(process.env);
await writer?.put(
  store.youtube("9HoIM5INxpI").metadataJson,
  bytes,
  "application/json",
);
```

`blobStore()` reads the `BLOB_STORE_PUBLIC_URL` environment variable where
there is an environment (Node, the web app's Worker), falling back to the
project's bucket. The browser has no environment, so the web app passes the
URL its server is configured with (`useBlobStore` in
`packages/web/src/lib/blob-store.ts`).
