# Deploying to production

Production is whatever commit the `production` branch points at.
[`.github/workflows/production.yml`](../../.github/workflows/production.yml)
builds a commit, migrates the production database, switches the Worker to the
new version, and only then fast-forwards `production` to that commit. A failed
run leaves `production` where it was.

## Deploying a commit

Only the repo owner can use these:

- **Comment `/deploy` on a merged PR.** Deploys that PR's merge commit. The
  bot reacts 👀, then replies when the deploy succeeds or fails.
- **Run the `production` workflow**, from the Actions tab or with
  `pnpm deploy:prod` (`gh workflow run production.yml`; add `-f ref=<ref>` for
  something other than `main`), with a branch, tag or SHA.

If a deploy fails, **re-run** the run to retry it. Migrating again is a no-op.

`production` only moves forward along `main`:

- The commit must be on `main`.
- A commit production already has (say, an older PR's after a newer one was
  deployed) is a no-op, never a rollback.

Don't push `production` by hand: nothing deploys on a push, so the branch
would stop matching what is live.

We don't roll back; we only roll forward. If a deploy breaks something, fix it
(or revert the bad PR) on `main` and deploy that. Don't use Cloudflare's
**Rollbacks** either: older code may not match the migrated schema, and the
older code's deploy refuses a database with migrations it doesn't know.

The workflow runs in the `production` environment, so the repo's
**Deployments** tab shows the live commit.

## What a deploy does

The workflow builds the app first. Nothing live changes, so a failed build is
harmless. Then
[`packages/web/scripts/deploy-built.sh`](../../packages/web/scripts/deploy-built.sh)
asks Neon for production's database URL and puts the migration as late as it
can:

1. Check production's migration history hasn't diverged from this commit.
2. `wrangler versions upload`: upload the new version, serving no traffic.
   Cloudflare validates the bundle here.
3. `pnpm db migrate` on production.
4. `wrangler versions deploy <id>@100%`: route all traffic to the new version.

So everything that can fail without touching the database fails before step 3.
If step 4 fails, production is migrated but serving the previous version; the
script prints the command to retry it.

Between steps 3 and 4, old code briefly runs on the new schema. Migrations
don't have to be backward-compatible: a migration can rename or drop what the
old code uses, in one step with the code that stops using it. The site may
break for the few seconds between the two steps, and that's accepted.

Scheduled workflows that use the production database (`scout.yml`,
`export-duckdb.yml`) check out `production`, so they run the code that matches
its schema. Their workflow files still come from `main`, so a change to how one
calls that code has to work with what is on `production`.

Versions don't carry routes, custom domains or cron triggers. If
`wrangler.jsonc` gains any, apply changes to them with
`pnpm exec wrangler triggers deploy` in `packages/web`.

## One-time setup

### Cloudflare

Leave Workers Builds (the Worker's **Settings → Build** Git connection)
disconnected, so GitHub is the only thing deploying.

The workflow uses the same `CLOUDFLARE_API_TOKEN` secret and
`CLOUDFLARE_ACCOUNT_ID` variable as PR previews.

### GitHub

The deploy script finds production's database URL itself: it asks Neon, with
the `NEON_API_KEY` secret and `NEON_PROJECT_ID` variable that PR previews use,
for the direct (unpooled) URL of the project's default branch. That URL is only for
migrating; the Worker reads its pooled URL from its own `DATABASE_URL` secret,
which new versions keep.

Protect `production` with a ruleset that blocks force pushes and deletion.
Don't restrict who can push or require PRs: the workflow pushes with the
built-in `GITHUB_TOKEN`, which can't bypass branch rules.

## Configuration

The Worker reads all of its configuration from its environment, on the server
(see [`packages/web/src/server/config.ts`](../../packages/web/src/server/config.ts)).
The browser gets only what that file's `PublicConfig` passes it, with the
first page.

- **Plain values** (like `BLOB_STORE_PUBLIC_URL`) are `vars` in
  [`packages/web/wrangler.jsonc`](../../packages/web/wrangler.jsonc). Dev, PR
  previews and production all read them from there; change one by committing.
- **Secrets** (`DATABASE_URL`) never go in that file: the dev server passes
  the one it resolves to the Worker (`vite.config.ts`), PR previews upload
  theirs with `--secrets-file`, and production's is set once on the Worker,
  which new versions keep.
- **`ISSUES_READ_TOKEN`**, a secret, is a fine-grained GitHub token with
  read access to this repository's issues, which the changeset review page
  (`/changesets/<issue>`) reads issues and their artifacts with. Set it once
  on the production Worker (`wrangler secret put ISSUES_READ_TOKEN`), and as
  the repository secret of the same name, which PR previews upload.
