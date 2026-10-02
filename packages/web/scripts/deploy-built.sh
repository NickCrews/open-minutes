#!/usr/bin/env bash
# Deploys an already-built web app (run `pnpm build` first) to the production
# Worker, migrating production's database as late as possible:
#
#   1. check production's migration history hasn't diverged from this checkout
#   2. upload the new Worker version without routing any traffic to it
#   3. migrate production
#   4. route 100% of traffic to the version from step 2
#
# Everything that can fail without touching the database (build, bundle
# validation, upload) fails before step 3. After it, only step 4 remains: a
# routing change that is safe to retry by hand with the command it prints.
#
# .github/workflows/production.yml runs this, and so does `pnpm deploy:prod`
# after building. It needs DATABASE_URL_PROD (the direct, unpooled URL) in the
# environment or in .env.local, and Cloudflare credentials (CLOUDFLARE_API_TOKEN
# or `wrangler login`). See docs/contributing/deploy.md.
set -euo pipefail

cd "$(dirname "$0")/.."

message="production @ $(git rev-parse HEAD)"

echo "==> Checking production's migration history"
status=$(pnpm --silent -w run db status --db prod --json)
if node -e 'process.exit(JSON.parse(process.argv[1]).diverged ? 0 : 1)' "$status"; then
  echo "$status" >&2
  echo "error: production's migration history diverged from this checkout; refusing to deploy." >&2
  exit 1
fi

echo "==> Uploading the new Worker version (no traffic yet)"
output_file=$(mktemp)
trap 'rm -f "$output_file"' EXIT
WRANGLER_OUTPUT_FILE_PATH="$output_file" pnpm exec wrangler versions upload --message "$message"
version_id=$(node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  const upload = lines.map((l) => JSON.parse(l)).find((e) => e.type === "version-upload");
  if (!upload?.version_id) process.exit(1);
  console.log(upload.version_id);
' "$output_file") || {
  echo "error: wrangler reported no uploaded version id" >&2
  exit 1
}
echo "Uploaded version ${version_id}"

echo "==> Migrating production"
pnpm -w run db migrate --db prod

echo "==> Routing all traffic to version ${version_id}"
deploy=(pnpm exec wrangler versions deploy "${version_id}@100%" --yes --message "$message")
if ! "${deploy[@]}"; then
  echo "error: production is migrated but still serving the previous version. Retry with:" >&2
  echo "  (cd packages/web && ${deploy[*]})" >&2
  exit 1
fi
