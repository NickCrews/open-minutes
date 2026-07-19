# Deployment options for `packages/web`

Research date: **2026-07-18**. Versions in this repo at time of research:
`@tanstack/solid-start` **1.167.37**, `@tanstack/solid-router` 1.168.20, Vite 7.3.2,
`drizzle-orm` 1.0.0-beta.21, `postgres` (postgres.js) **3.4.9**. Claims below are
version-specific to roughly this generation of TanStack Start (the post-Nitro,
Vite-native architecture, ~v1.121+); re-check the linked docs before acting on
this months from now.

## TL;DR — can I deploy to Cloudflare Workers?

**Yes.** As of the current docs, TanStack Start's **Solid** variant officially
documents Cloudflare Workers as a first-class deployment target (Cloudflare is a
TanStack hosting partner). The [official Solid hosting
guide](https://tanstack.com/start/latest/docs/framework/solid/guide/hosting)
shows the exact setup: add `@cloudflare/vite-plugin` to `vite.config.ts` and a
`wrangler.jsonc` whose `main` is **`@tanstack/solid-start/server-entry`** (that
export exists in the installed 1.167.37) with the **`nodejs_compat`** flag.

The database is the real work, not the framework:

- `postgres.js` + drizzle **do** run on Workers. Cloudflare officially supports
  postgres.js (≥ 3.4.5 — this repo has 3.4.9) via
  [Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/),
  and [drizzle is documented working over
  it](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/).
  Hyperdrive is [included on the Workers Free
  plan](https://developers.cloudflare.com/hyperdrive/platform/pricing/) (100k
  queries/day).
- But `packages/core/src/db` needs changes: `resolveDatabaseUrl()` loads a root
  `.env.local` off the filesystem via dotenv, and `packages/web/src/server/db.ts`
  holds a module-level singleton client — both are Node-server patterns. On
  Workers the connection string must come from the Hyperdrive binding (or env)
  and the client should be created per request.

**Lowest-friction path today** is not Workers, though — it's any plain Node
host (Railway/Fly/VPS): zero code changes to the DB layer. One repo bug either
way: the `start` script (`node .output/server/index.mjs`) points at Nitro-era
output, but `vite build` here emits `dist/server/server.js` (a fetch-handler
module). See [§3](#3-other-deployment-options).

---

## 1. Cloudflare Workers feasibility (TanStack **Solid** Start)

**Status: officially supported and documented for the Solid variant.**

Primary sources:

- [TanStack Start Solid hosting guide](https://tanstack.com/start/latest/docs/framework/solid/guide/hosting)
  — lists Cloudflare Workers as a partner target and gives Solid-specific
  config (imports from `@tanstack/solid-start/plugin/vite`, `main:
"@tanstack/solid-start/server-entry"`).
- [Cloudflare's TanStack Start framework guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
  — Cloudflare's own guide; note it is written for the **React** variant
  (`@tanstack/react-start/server-entry`), but the mechanism is identical and
  the TanStack Solid docs mirror it with the Solid package names.
  `npm create cloudflare@latest -- app --framework=tanstack-start` scaffolds the
  React flavor.
- [Cloudflare is an official TanStack partner](https://tanstack.com/partners/cloudflare).

### Required config (per the Solid hosting guide)

`vite.config.ts` — add the Cloudflare plugin _before_ `tanstackStart()`, bound
to the `ssr` environment:

```ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import viteSolid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteSolid({ ssr: true }),
  ],
});
```

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "open-minutes",
  "compatibility_date": "2026-07-18",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/solid-start/server-entry",
  "observability": { "enabled": true },
}
```

Scripts: `"deploy": "vite build && wrangler deploy"`, plus `wrangler types`
(`cf-typegen`) for binding types. Bindings are accessed in server code via
`import { env } from "cloudflare:workers"`; with `nodejs_compat` and a
compatibility date ≥ 2025-04-01, vars/secrets are [also populated onto
`process.env`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/)
(flag `nodejs_compat_populate_process_env`, default-on) — which matters for the
`@t3-oss/env-core` + `process.env` usage in this repo.

### Maturity caveats for the Solid variant

Solid + Cloudflare had real teething problems during the 2025 RC period, all
now closed in the TanStack/router repo well before v1.167:

- [#5291 dev server broken with `@tanstack/solid-start` + `@cloudflare/vite-plugin`](https://github.com/TanStack/router/issues/5291) (closed 2025-09-29)
- [#5213 RC Start + Cloudflare fails to build/deploy (solid-js/web export errors)](https://github.com/TanStack/router/issues/5213) (closed 2025-10-13)
- [#5400 Solid Start + Cloudflare plugin crashes dev server on some server-fn import graphs](https://github.com/TanStack/router/issues/5400) (closed 2025-10-22)

Takeaway: the path works but is younger than the React one (Cloudflare's own
guide only covers React). Expect occasional dev-server rough edges; pin
versions and test `vite dev` + `wrangler deploy --dry-run` early.

## 2. Postgres from Workers

### Hyperdrive + postgres.js (the supported path for this stack)

Cloudflare's [postgres.js driver page](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)
officially supports postgres.js against Hyperdrive:

- Minimum `postgres` version **3.4.5** — this repo has **3.4.9** ✅.
- Requires `nodejs_compat` (and per the [direct-connection tutorial](https://developers.cloudflare.com/workers/tutorials/postgres/), compatibility date ≥ 2024-09-23).
- Create the client **per request** from the binding:
  `postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })`.
  `max: 5` respects the Worker's concurrent-connection limit; Hyperdrive does
  the real pooling at the edge ([connection pooling docs](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)).
  Keep `prepare: true` (default) so Hyperdrive can cache prepared statements.
- [Drizzle over Hyperdrive is documented](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
  with both postgres.js and node-postgres. Drizzle itself is pure JS/TS — no
  runtime obstacle.
- Hyperdrive points at any existing PostgreSQL (wherever `DATABASE_URL_PROD`
  lives today); you register the origin URL with `wrangler hyperdrive create`.
- [Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/):
  included in Workers plans at no extra charge; Free plan = 100,000
  queries/day, Paid = unlimited; query caching included.

Direct TCP without Hyperdrive is also possible ([Workers Postgres tutorial](https://developers.cloudflare.com/workers/tutorials/postgres/)
demonstrates node-postgres directly with `nodejs_compat`), but every isolate
opens fresh connections to the origin with no pooling or caching — the tutorial
itself moves you onto Hyperdrive. Since Hyperdrive is free, there's no reason
to skip it.

### What has to change in this repo's DB code

Current code (`packages/core/src/db/index.ts`, `resolve.mjs`,
`packages/web/src/server/db.ts`):

1. **Env resolution** — `resolveDatabaseUrl()` calls `loadRootDotEnv()`, which
   reads `.env.local` from disk via dotenv relative to `import.meta.url`. On
   Workers there is no workspace filesystem. `loadRootDotEnv()` already treats
   a missing file as a no-op, so the minimal change is making the dotenv import
   lazy/conditional (or a Workers-safe stub) so the bundle doesn't drag in
   `fs`-touching code; the URL then comes from `process.env.DATABASE_URL`
   (auto-populated from Worker vars/secrets, see [process docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/))
   or explicitly from `env.HYPERDRIVE.connectionString` passed into `getDb(url)`
   — which the existing `target`-as-URL API already supports.
2. **Client lifetime** — `packages/web/src/server/db.ts` caches a module-level
   singleton. On Workers, create the client per request (Cloudflare's
   postgres.js guide: instantiation is cheap because Hyperdrive owns the pool)
   and pass `{ max: 5 }`. Practically: change `db()` to build from the request
   context / binding instead of `instance ??=`.
3. **Driver options** — add `max: 5`, consider `fetch_types: false` (the schema
   here does use arrays via drizzle? verify — if any array columns exist, leave
   fetch_types on).

### Alternatives to Hyperdrive

- **Neon serverless driver** ([official docs](https://neon.com/docs/serverless/serverless-driver)):
  Postgres over HTTP/WebSocket, built for edge runtimes, works with
  `drizzle-orm/neon-http` / `neon-serverless`. Not a drop-in for postgres.js
  (different client construction); only worth it if you'd move the database to
  Neon anyway.
- **Supabase** (supabase-js over HTTP, or its pooler + a TCP driver) — same
  trade: fine, but implies moving/hosting the DB there.
- **Drizzle + Cloudflare D1** — would mean leaving Postgres for SQLite;
  non-starter given the existing schema/migrations.

Given the repo already standardizes on postgres.js + real Postgres, Hyperdrive
is the option that changes the least code.

## 3. Other deployment options

First, a repo bug that affects the Node paths: **the `start` script is stale.**
`packages/web/package.json` has `"start": "node .output/server/index.mjs"`
(Nitro-era output), but `vite build` with the current Vite-native TanStack
Start emits `dist/client/` + `dist/server/server.js`, whose default export is a
fetch-handler entry (`createServerEntry({ fetch })` — verified in this repo's
`dist/server/server.js`). Per the [hosting guide](https://tanstack.com/start/latest/docs/framework/solid/guide/hosting),
to get a runnable Node server you either add the **Nitro vite plugin**
(`import { nitro } from 'nitro/vite'`, plugins `[tanstackStart(), nitro(), viteSolid({ssr:true})]`),
which restores `.output/server/index.mjs`, or serve the fetch handler yourself
(the guide shows `srvx --prod -s ../client dist/server/index.js` for the
equivalent Rsbuild output, and notes any Node server that serves the client
assets and calls the entry's `fetch` works).

| Option                          | Changes needed                                                                                                                                                            | Hobby-scale cost                                                                                                                  | Postgres fit                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Node server on VPS / Docker** | Fix start script (add `nitro()` or an srvx/custom entry); Dockerfile                                                                                                      | Whatever the box costs (~$4–6/mo VPS)                                                                                             | Perfect — long-lived process, postgres.js pools natively; zero DB-code changes                                     |
| **Railway** (TanStack partner)  | Same Node fix; connect repo — [Railway section of hosting guide](https://tanstack.com/start/latest/docs/framework/solid/guide/hosting) says follow the Nitro instructions | [Hobby $5/mo incl. usage](https://railway.com/pricing); managed Postgres billed as usage                                          | Excellent — app + Postgres in one place, private networking                                                        |
| **Fly.io**                      | Same Node fix + Dockerfile                                                                                                                                                | [shared-cpu-1x/256MB ≈ $2/mo](https://fly.io/docs/about/pricing/); unmanaged single-node Postgres ≈ $2/mo, Managed Postgres extra | Very good — long-lived VM, can colocate Postgres                                                                   |
| **Render**                      | Same Node fix; connect repo                                                                                                                                               | Free web-service tier (spins down) or cheapest paid instance; see [pricing](https://render.com/pricing)                           | Good — managed Postgres offering on-platform                                                                       |
| **Netlify** (partner)           | Add [`@netlify/vite-plugin-tanstack-start`](https://tanstack.com/start/latest/docs/framework/solid/guide/hosting)                                                         | Free tier generous for hobby                                                                                                      | OK — serverless functions, so pool via provider pooler/pgbouncer; postgres.js per-invocation connections need care |
| **Vercel**                      | Hosting guide routes Vercel through the Nitro instructions                                                                                                                | Hobby free tier                                                                                                                   | Same serverless caveat as Netlify                                                                                  |
| **Cloudflare Workers**          | §1 + §2 changes (vite plugin, wrangler.jsonc, Hyperdrive, db-code edits)                                                                                                  | Workers [Free: 100k req/day / Paid $5/mo](https://developers.cloudflare.com/workers/platform/pricing/); Hyperdrive included       | Good via Hyperdrive; DB itself must live elsewhere                                                                 |
| **Cloudflare Containers**       | Dockerfile + Worker shim; run the Node build unchanged                                                                                                                    | Requires [Workers Paid $5/mo; per-10ms billing, ~25 GiB-h memory included](https://developers.cloudflare.com/containers/pricing/) | Good — real Node process; but more moving parts than a plain VPS for the same result                               |

## 4. Recommendation

**Lowest friction: Railway (or Fly.io / any VPS).** The only change is fixing
the build/start pair — add `nitro()` from `nitro/vite` to
`packages/web/vite.config.ts` so `node .output/server/index.mjs` exists again —
and setting `DATABASE_URL`. The whole drizzle + postgres.js + dotenv/env
resolution layer runs unchanged, and Railway can host the Postgres next to the
app for ~$5/mo. This is also the TanStack-partner-blessed path.

**If you want Cloudflare Workers**, it's fully doable as of solid-start 1.167:

1. `pnpm add -D @cloudflare/vite-plugin wrangler` in `packages/web`.
2. `vite.config.ts`: prepend `cloudflare({ viteEnvironment: { name: "ssr" } })`
   to the plugins array (before `tanstackStart()`).
3. Add `wrangler.jsonc` with `main: "@tanstack/solid-start/server-entry"`,
   `compatibility_flags: ["nodejs_compat"]`, `compatibility_date` = today.
4. Create a Hyperdrive config pointing at the prod Postgres:
   `wrangler hyperdrive create open-minutes --connection-string="postgres://…"`,
   then add the `hyperdrive` binding (`HYPERDRIVE`) to `wrangler.jsonc`.
5. `packages/core/src/db`: make `loadRootDotEnv()` a no-op off-Node (lazy
   dotenv import), and accept the URL from the caller.
6. `packages/web/src/server/db.ts`: drop the singleton; build the drizzle
   client per request from `env.HYPERDRIVE.connectionString` (via
   `import { env } from "cloudflare:workers"`), with `postgres(url, { max: 5 })`.
7. Verify `@t3-oss/env-core` reads work — with the default
   `nodejs_compat_populate_process_env`, Worker vars/secrets appear on
   `process.env`.
8. `vite build && wrangler deploy` (add `cf-typegen: wrangler types`).

Budget an afternoon for step 5–6 plus dev-server testing — the Solid +
Cloudflare combination is officially supported but newer than the React one
(see the closed issues in §1).
