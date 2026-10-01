#!/usr/bin/env tsx
// The database harness CLI, behind the root `pnpm db` script. See
// docs/contributing/db.md. The datasets `--data` can name come from the
// repository's dbranch.config.ts (see ./config.ts), so this package imports no
// data itself.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { assertSafeName, isLocalUrl, withAdmin } from "./cluster";
import { type DbConfig, loadConfig } from "./config";
import {
  databaseStatus,
  type DatabaseStatus,
  ensureDatabase,
  prepareDatabase,
  RESET_POLICIES,
  type ResetPolicy,
  wipeDatabase,
} from "./ensure";
import { describeStatus, isDiverged } from "./migration-status";
import {
  LOCAL_DATABASE_PREFIX,
  localDatabaseName,
  resolveDatabaseUrl,
} from "./resolve";
import { TEMPLATE_PREFIX, TEST_DB_PREFIX, templateName } from "./testing";

// Loaded on first use, so commands that don't need datasets (migrate,
// generate, ...) don't import them.
let config: Promise<DbConfig> | undefined;
function dbConfig(): Promise<DbConfig> {
  return (config ??= loadConfig());
}

const targetArg = {
  db: {
    type: "string",
    description:
      'Target database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
  },
} as const;

const schemaVersionArg = {
  "schema-version": {
    type: "string",
    description:
      'Schema to bring it to: "latest" (default), or a migration by name, timestamp, or tag.',
    default: "latest",
  },
} as const;

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "****";
  return u.toString();
}

function resetPolicy(flag: string, value: string): ResetPolicy {
  if (!(RESET_POLICIES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown --${flag} "${value}"; expected one of: ${RESET_POLICIES.join(", ")}`,
    );
  }
  return value as ResetPolicy;
}

const up = defineCommand({
  meta: {
    name: "up",
    description:
      "Bring a database to a declared schema version and dataset, changing as little as possible. What `pnpm dev` runs. On a local database: (1) create it if missing; (2) reset the schema if its history diverged (see --schema-reset); (3) apply pending migrations; (4) seed the dataset if the database has no data (see --data-reset). Remote databases are only checked, never changed.",
  },
  args: {
    ...targetArg,
    data: {
      type: "string",
      description:
        'Dataset to declare: one of the datasets in dbranch.config.ts, or "none". Default: its defaultDataset, or none with an older --schema-version.',
    },
    ...schemaVersionArg,
    "schema-reset": {
      type: "string",
      description:
        'When to wipe tables and data and re-apply every migration. "if-needed" (default): only when the history diverged (another branch\'s migrations, an edited migration, or a newer schema). "never": error instead. "always": every time.',
      default: "if-needed",
    },
    "data-reset": {
      type: "string",
      description:
        'When to apply the dataset over existing data. "never" (default): only seed a database with no data. "if-needed": also replace data that isn\'t the declared dataset. "always": every time, e.g. to undo hand edits.',
      default: "never",
    },
  },
  async run({ args }) {
    const schemaReset = resetPolicy("schema-reset", args["schema-reset"]);
    const dataReset = resetPolicy("data-reset", args["data-reset"]);
    const schemaVersion = args["schema-version"];
    const { datasets, defaultDataset } = await dbConfig();
    const dataName =
      args.data ??
      (schemaVersion === "latest" ? (defaultDataset ?? "none") : "none");
    if (dataName !== "none" && !(dataName in datasets)) {
      throw new Error(
        `Unknown --data "${dataName}"; expected one of: none, ${Object.keys(datasets).join(", ")}`,
      );
    }
    if (dataName !== "none" && schemaVersion !== "latest") {
      throw new Error(
        `--data "${dataName}" needs --schema-version latest: seeders write ` +
          `the latest schema. Use --data none for older versions.`,
      );
    }
    await prepareDatabase(resolveDatabaseUrl(args.db), {
      schemaVersion,
      data: dataName === "none" ? undefined : datasets[dataName],
      schemaReset,
      dataReset,
    });
  },
});

const migrate = defineCommand({
  meta: {
    name: "migrate",
    description:
      "Apply pending migrations, up to --schema-version. Never resets or seeds; errors if the history diverged. What `pnpm deploy:prod` runs.",
  },
  args: { ...targetArg, ...schemaVersionArg },
  async run({ args }) {
    await ensureDatabase(resolveDatabaseUrl(args.db), {
      schemaVersion: args["schema-version"],
      schemaReset: "never",
      // A missing local database starts empty rather than as a copy of
      // main's, which may be ahead of this checkout and so diverged.
      cloneFrom: null,
    });
  },
});

const wipe = defineCommand({
  meta: {
    name: "wipe",
    description:
      "Drop a database's tables, data and migration history. Refuses non-local databases unless ALLOW_REMOTE_WIPE=1.",
  },
  args: { ...targetArg },
  async run({ args }) {
    await wipeDatabase(resolveDatabaseUrl(args.db));
  },
});

// drizzle-kit reads drizzle.config.ts from the @open-minutes/db package root.
const DB_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function drizzleKit(args: string[]): void {
  execFileSync("pnpm", ["exec", "drizzle-kit", ...args], {
    cwd: DB_PACKAGE_DIR,
    stdio: "inherit",
  });
}

const generate = defineCommand({
  meta: {
    name: "generate",
    description:
      "Generate a migration from packages/db/src/schema.ts changes (drizzle-kit generate)",
  },
  run() {
    drizzleKit(["generate"]);
  },
});

const check = defineCommand({
  meta: {
    name: "check",
    description: "Check the migrations for conflicts (drizzle-kit check)",
  },
  run() {
    drizzleKit(["check"]);
  },
});

const studio = defineCommand({
  meta: {
    name: "studio",
    description:
      "Open Drizzle Studio on a database. Never changes it; warns if it doesn't match this checkout.",
  },
  args: { ...targetArg },
  async run({ args }) {
    const url = resolveDatabaseUrl(args.db);
    const s = await databaseStatus(url);
    if (!s.exists || !s.migrations) {
      throw new Error(
        `${redact(url)} does not exist; \`pnpm db up\` creates it.`,
      );
    }
    if (s.migrations.pending.length > 0 || isDiverged(s.migrations)) {
      console.error(
        `Note: this database doesn't match this checkout's schema ` +
          `(\`pnpm db status\` for details, \`pnpm db up\` to fix it).`,
      );
    }
    // drizzle.config.ts resolves its target from $DB.
    process.env.DB = url;
    drizzleKit(["studio"]);
  },
});

const status = defineCommand({
  meta: {
    name: "status",
    description:
      "Show whether a database matches this checkout: pending, unknown, or modified migrations, and which data it holds",
  },
  args: {
    ...targetArg,
    check: {
      type: "boolean",
      description:
        "Exit non-zero unless every migration in this checkout is applied and history hasn't diverged (for deploy gates)",
      default: false,
    },
    json: {
      type: "boolean",
      description:
        "Print the state as JSON instead (behind/ahead/modified migrations, diverged, data), for scripts",
      default: false,
    },
  },
  async run({ args }) {
    const url = resolveDatabaseUrl(args.db);
    const s = await databaseStatus(url);
    if (args.check && !isCurrent(s)) process.exitCode = 1;
    if (args.json) {
      console.log(JSON.stringify(statusJson(s, await dbConfig()), null, 2));
      return;
    }
    const host = new URL(url).hostname;
    console.log(`Database:        ${redact(url)}`);
    console.log(
      `Location:        ` +
        (s.local
          ? `local (${host}): \`pnpm db up\` may reset it, \`pnpm db wipe\` empties it`
          : `remote (${host}): only \`pnpm db migrate\` changes it`),
    );
    if (!s.exists || !s.migrations) {
      console.log("State:           does not exist (run `pnpm db up`)");
      return;
    }
    console.log(
      `Schema:          ${s.schemaVersion ?? "(empty)"} (${s.appliedCount} migration(s) applied)`,
    );
    console.log(`Data:            ${describeData(s, await dbConfig())}`);
    const counts = Object.entries(s.rowCounts);
    if (counts.length > 0) {
      console.log(
        `                 ${counts.map(([t, n]) => `${n} ${t}`).join(", ")}`,
      );
    }
    console.log(describeStatus(s.migrations));
  },
});

/** Every migration in this checkout is applied, and history hasn't diverged. */
function isCurrent(s: DatabaseStatus): boolean {
  return (
    s.migrations !== null &&
    s.migrations.pending.length === 0 &&
    !isDiverged(s.migrations)
  );
}

/**
 * `pnpm db status --json`. Migration lists are named like git's ahead/behind:
 * `behind` are in this checkout but not applied (`pnpm db migrate` applies
 * them), `ahead` are applied but not in this checkout, `modified` were edited
 * after being applied. Either of the last two means history diverged.
 */
function statusJson(s: DatabaseStatus, config: DbConfig) {
  const m = s.migrations;
  const declared = s.data && config.datasets[s.data.name];
  return {
    exists: s.exists,
    local: s.local,
    schemaVersion: s.schemaVersion,
    appliedCount: s.appliedCount,
    behind: m?.pending ?? [],
    ahead: m?.unknown ?? [],
    modified: m?.modified ?? [],
    diverged: m !== null && isDiverged(m),
    current: isCurrent(s),
    data: s.data && {
      name: s.data.name,
      fingerprint: s.data.fingerprint,
      seededAt: s.data.appliedAt.toISOString(),
      // null when this checkout doesn't declare the dataset.
      current: declared ? declared.fingerprint === s.data.fingerprint : null,
    },
    rowCounts: s.rowCounts,
  };
}

/** The `Data:` line of `pnpm db status`: which dataset, when, and whether it's current. */
function describeData(s: DatabaseStatus, config: DbConfig): string {
  if (!s.data) {
    const empty = Object.values(s.rowCounts).every((n) => n === 0);
    return empty
      ? config.defaultDataset
        ? `empty (\`pnpm db up\` seeds the ${config.defaultDataset} dataset)`
        : "empty"
      : "untracked: not seeded by `pnpm db`, e.g. production or hand-entered data";
  }
  const seeded = `${s.data.name} (${s.data.fingerprint}), seeded ${s.data.appliedAt.toISOString()}`;
  const declared = config.datasets[s.data.name];
  if (!declared) return `${seeded}; not a dataset this checkout declares`;
  if (declared.fingerprint === s.data.fingerprint) return `${seeded}; current`;
  return (
    `${seeded}; stale, this checkout declares ${declared.fingerprint} ` +
    `(\`pnpm db up --data ${s.data.name} --data-reset if-needed\` reseeds it)`
  );
}

function localGitBranches(): string[] {
  const out = execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

const prune = defineCommand({
  meta: {
    name: "prune",
    description:
      "List (or with --yes, drop) local databases of deleted branches, leftover test databases, and outdated test templates. Databases in use are skipped.",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Actually drop them",
      default: false,
    },
  },
  async run({ args }) {
    const base = resolveDatabaseUrl("local");
    if (!isLocalUrl(base)) {
      throw new Error(`"local" resolves to a non-local server; not pruning.`);
    }
    const { datasets } = await dbConfig();
    const keep = new Set([
      ...localGitBranches().map((b) => localDatabaseName(b)),
      localDatabaseName(),
      templateName("latest", undefined),
      ...Object.values(datasets).map((d) => templateName("latest", d)),
    ]);
    await withAdmin(base, async (admin) => {
      const rows = await admin<{ datname: string; in_use: boolean }[]>`
        SELECT d.datname, EXISTS (
          SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname
        ) AS in_use
        FROM pg_database d
        WHERE d.datname LIKE ${`${LOCAL_DATABASE_PREFIX.replaceAll("_", "\\_")}%`}
           OR d.datname LIKE ${`${TEST_DB_PREFIX.replaceAll("_", "\\_")}%`}
        ORDER BY d.datname`;
      const unneeded = rows.filter((r) => !keep.has(r.datname));
      if (unneeded.length === 0) {
        console.error("Nothing to prune.");
        return;
      }
      for (const { datname: name, in_use } of unneeded) {
        const line = `${name}  (${pruneReason(name)})`;
        if (in_use) {
          console.log(`${line}: in use, skipped`);
        } else if (args.yes) {
          await admin.unsafe(
            `DROP DATABASE IF EXISTS "${assertSafeName(name)}"`,
          );
          console.log(`dropped ${line}`);
        } else {
          console.log(line);
        }
      }
      if (!args.yes) console.error("(dry run; pass --yes to drop these)");
    });
  },
});

/** Why `prune` considers a database unneeded, for its listing. */
function pruneReason(name: string): string {
  if (name.startsWith(TEMPLATE_PREFIX)) return "old test template";
  if (name.startsWith(TEST_DB_PREFIX)) return "left by an interrupted test run";
  return "its git branch is gone";
}

const main = defineCommand({
  meta: {
    name: "db",
    description: "Declarative database harness for open-minutes",
  },
  subCommands: {
    up,
    migrate,
    wipe,
    status,
    prune,
    generate,
    check,
    studio,
  },
});

await runMain(main);
