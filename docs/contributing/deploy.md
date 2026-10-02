# Deploying to production

Production is whatever commit the `production` branch points at.
[`.github/workflows/production.yml`](../../.github/workflows/production.yml)
deploys it: on every push to that branch, it builds the web app, migrates the
production database, and switches the Worker to the new version.

## Deploying a commit

Only the repo owner can use these:

- **Comment `/deploy` on a merged PR.** Deploys that PR's merge commit. The
  bot reacts 👀, then replies when the deploy succeeds or fails.
- **Run the `production` workflow** from the Actions tab, with a branch, tag or
  SHA (default `main`).

Both fast-forward `production` to the commit and deploy it in the same run. A
push made by a workflow doesn't trigger other workflows, so moving the branch
and deploying it can't be separate workflows.

If a deploy fails, **re-run failed jobs** on the run to retry it.

`production` only moves forward along `main`:

- The commit must be on `main`.
- A commit production already has (say, an older PR's after a newer one was
  promoted) is a no-op, never a rollback.

We don't roll back; we only roll forward. If a deploy breaks something, fix it
(or revert the bad PR) on `main` and deploy that. Don't use Cloudflare's
**Rollbacks** either: older code may not match the migrated schema, and the
older code's deploy refuses a database with migrations it doesn't know.

## What a deploy does

The workflow builds the app first. Nothing live changes, so a failed build is
harmless. Then
[`packages/web/scripts/deploy-built.sh`](../../packages/web/scripts/deploy-built.sh)
puts the database migration as late as it can:

1. Check production's migration history hasn't diverged from this commit.
2. `wrangler versions upload`: upload the new version, serving no traffic.
   Cloudflare validates the bundle here.
3. `pnpm db migrate --db prod`.
4. `wrangler versions deploy <id>@100%`: route all traffic to the new version.

So everything that can fail without touching the database fails before step 3.
If step 4 fails, production is migrated but serving the previous version; the
script prints the command to retry it.

Between steps 3 and 4, old code briefly runs on the new schema, so migrations
must be backward-compatible: add a column in one deploy, use it in the next,
and drop columns only once no deployed code reads them.

`pnpm deploy:prod` runs the same script after building, for deploying from a
laptop (with `DATABASE_URL_PROD` in `.env.local` and `wrangler login`).

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

The workflow finds production's database URL itself: it asks Neon, with the
`NEON_API_KEY` secret and `NEON_PROJECT_ID` variable that PR previews use, for
the direct (unpooled) URL of the project's default branch. That URL is only for
migrating; the Worker reads its pooled URL from its own `DATABASE_URL` secret,
which new versions keep.

Protect `production` with a ruleset that blocks force pushes and deletion.
Don't restrict who can push or require PRs: the workflow pushes with the
built-in `GITHUB_TOKEN`, which can't bypass branch rules. Anyone who can push
to the repo can push `production` directly, and that push deploys.
