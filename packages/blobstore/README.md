# @open-minutes/blobstore

The project's blob store: an S3-compatible bucket (Cloudflare R2), publicly
readable at `BLOB_STORE_PUBLIC_URL`, one top-level prefix per kind of file.
This package reads a file from it by key. It uses only `fetch`, so the web app
imports it too.

```ts
import { blobStore } from "@open-minutes/blobstore";

const store = blobStore(); // or blobStore(process.env.BLOB_STORE_PUBLIC_URL)
store.url("exports/open-minutes.duckdb");
const bytes = await store.get("youtube/9HoIM5INxpI/info.json"); // null if absent
```
