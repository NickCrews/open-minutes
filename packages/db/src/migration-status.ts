// Pure comparison of "migrations this code expects" against "migrations the
// database's journal says were applied". No node or driver imports, so any
// runtime (the harness under node, the web app in workerd) can use it with
// rows fetched through whatever driver it has.

/** One migration, as drizzle identifies it: its folder name and sql hash. */
export interface MigrationRef {
  name: string;
  hash: string;
}

/** The drizzle journal: schema and table drizzle's migrator records into. */
export const JOURNAL_SCHEMA = "drizzle";
export const JOURNAL_TABLE = "__drizzle_migrations";

export interface MigrationStatus {
  /** In the code, not yet applied. `migrate` will apply these. */
  pending: string[];
  /**
   * Applied, but absent from the code: the database is ahead of (or has
   * diverged from) this checkout — typically another git branch migrated it.
   */
  unknown: string[];
  /**
   * Applied under this name, but the file has since changed. drizzle matches
   * by name, so it would silently never re-run these.
   */
  modified: string[];
}

export function compareMigrations(
  local: readonly MigrationRef[],
  applied: readonly { name: string | null; hash: string }[],
): MigrationStatus {
  const appliedByName = new Map<string, string>();
  const appliedHashes = new Set<string>();
  for (const row of applied) {
    appliedHashes.add(row.hash);
    if (row.name !== null) appliedByName.set(row.name, row.hash);
  }
  const localNames = new Set(local.map((m) => m.name));
  const localHashes = new Set(local.map((m) => m.hash));

  const pending: string[] = [];
  const modified: string[] = [];
  for (const m of local) {
    const hash = appliedByName.get(m.name);
    if (hash === undefined) pending.push(m.name);
    else if (hash !== m.hash) modified.push(m.name);
  }
  const unknown = applied
    .filter((row) =>
      row.name !== null
        ? !localNames.has(row.name)
        : !localHashes.has(row.hash),
    )
    .map((row) => row.name ?? `<unnamed ${row.hash.slice(0, 12)}>`);
  return { pending, unknown, modified };
}

/** True when the database has history this code doesn't know about. */
export function isDiverged(status: MigrationStatus): boolean {
  return status.unknown.length > 0 || status.modified.length > 0;
}

/** Multi-line, human-readable explanation of a non-clean status. */
export function describeStatus(status: MigrationStatus): string {
  const lines: string[] = [];
  const section = (title: string, names: string[]) => {
    if (names.length === 0) return;
    lines.push(`${title}:`, ...names.map((n) => `  - ${n}`));
  };
  section("Pending (in code, not applied)", status.pending);
  section("Unknown (applied, not in this checkout)", status.unknown);
  section("Modified since applied", status.modified);
  return lines.length ? lines.join("\n") : "Up to date.";
}
