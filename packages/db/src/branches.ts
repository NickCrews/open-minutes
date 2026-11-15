import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import {
  assertSafeName,
  databaseName,
  urlForDatabase,
  withAdmin,
} from "./cluster";

// Branches: copies of a database that can be reset to their parent's current
// state and thrown away, for agents' playgrounds and for checking a changeset
// away from main. A branch is made from main or from another branch. See
// docs/contributing/db.md#branches.

/** A branch, as `list` reports it. */
export interface Branch {
  name: string;
  /** The branch it was made from; null for main. */
  parent: string | null;
  createdAt: string;
}

/** Making, resetting and deleting branches of one main database. */
export interface Branches {
  /** Make `name` a copy of `from` (another branch), or of main. */
  create(options: { name: string; from?: string }): Promise<Branch>;
  /** A connection URL for the branch, as main's owner. */
  url(name: string): Promise<string>;
  /** Put the branch back as its parent is now. */
  reset(name: string): Promise<void>;
  /** Delete the branch, closing its connections. Nothing if it doesn't exist. */
  remove(name: string): Promise<void>;
  /** Every branch, or those whose names start with `prefix`. */
  list(options?: { prefix?: string }): Promise<Branch[]>;
}

/** Branch names: lowercase letters and digits, in parts joined by "-" or "/". */
const BRANCH_NAME = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** The stem of every local branch's database name. */
export const LOCAL_BRANCH_PREFIX = "dbranch__";

/**
 * The database a local branch lives in: its name with "/" as "__" and "-" as
 * "_", after {@link LOCAL_BRANCH_PREFIX}. Names can't hold "_", so no two
 * branches share a database.
 */
export function localBranchDatabase(name: string): string {
  if (!BRANCH_NAME.test(name))
    throw new Error(
      `Bad branch name ${JSON.stringify(name)}: use lowercase letters and digits, in parts joined by "-" or "/"`,
    );
  const db = `${LOCAL_BRANCH_PREFIX}${name.replaceAll("/", "__").replaceAll("-", "_")}`;
  // Postgres truncates identifiers beyond 63 bytes.
  if (db.length > 63)
    throw new Error(`Branch name ${JSON.stringify(name)} is too long`);
  return assertSafeName(db);
}

/** The branch a local branch database holds, or undefined for any other database. */
function localBranchName(db: string): string | undefined {
  if (!db.startsWith(LOCAL_BRANCH_PREFIX)) return undefined;
  return db
    .slice(LOCAL_BRANCH_PREFIX.length)
    .replaceAll("__", "/")
    .replaceAll("_", "-");
}

/**
 * Branches as databases on main's Postgres server, each made with `CREATE
 * DATABASE ... TEMPLATE`. Making or resetting one fails while anything else is
 * connected to the database it copies, which Postgres requires be idle. A
 * branch's parent and creation time are kept in its database's comment.
 */
export function localBranches({ main }: { main: string }): Branches {
  const mainDb = assertSafeName(databaseName(main));
  const sourceDb = (parent: string | null) =>
    parent === null ? mainDb : localBranchDatabase(parent);

  const read = async (
    admin: postgres.Sql,
    name: string,
  ): Promise<Branch | undefined> => {
    const [row] = await admin<{ comment: string | null }[]>`
      SELECT shobj_description(oid, 'pg_database') AS comment
      FROM pg_database WHERE datname = ${localBranchDatabase(name)}`;
    if (!row) return undefined;
    return { name, ...parseComment(row.comment) };
  };

  /** Copy the branch's parent into `db` (default: the branch's database). */
  const copy = async (
    admin: postgres.Sql,
    branch: Branch,
    db = localBranchDatabase(branch.name),
  ): Promise<void> => {
    const source = sourceDb(branch.parent);
    try {
      await admin.unsafe(`CREATE DATABASE "${db}" TEMPLATE "${source}"`);
    } catch (err) {
      if ((err as { code?: string }).code === "55006")
        throw new Error(
          `Can't copy ${branch.parent ?? "main"} (${source}) while something else is connected to it: close it, then try again`,
          { cause: err },
        );
      throw err;
    }
    const comment = JSON.stringify({
      parent: branch.parent,
      createdAt: branch.createdAt,
    });
    await admin.unsafe(
      `COMMENT ON DATABASE "${db}" IS ${quoteLiteral(comment)}`,
    );
  };

  return {
    create: ({ name, from }) =>
      withAdmin(main, async (admin) => {
        if (await read(admin, name))
          throw new Error(`Branch ${name} already exists`);
        if (from !== undefined && !(await read(admin, from)))
          throw new Error(`No branch ${from} to copy`);
        const branch = {
          name,
          parent: from ?? null,
          createdAt: new Date().toISOString(),
        };
        await copy(admin, branch);
        return branch;
      }),
    url: async (name) =>
      withAdmin(main, async (admin) => {
        if (!(await read(admin, name))) throw new Error(`No branch ${name}`);
        return urlForDatabase(main, localBranchDatabase(name));
      }),
    reset: (name) =>
      withAdmin(main, async (admin) => {
        const branch = await read(admin, name);
        if (!branch) throw new Error(`No branch ${name}`);
        // Copy first, so a parent that can't be copied leaves the branch as
        // it was.
        const db = localBranchDatabase(name);
        const fresh = assertSafeName(
          `dbranch_reset_${randomBytes(6).toString("hex")}`,
        );
        await copy(admin, branch, fresh);
        await admin.unsafe(`DROP DATABASE "${db}" WITH (FORCE)`);
        await admin.unsafe(`ALTER DATABASE "${fresh}" RENAME TO "${db}"`);
      }),
    remove: (name) =>
      withAdmin(main, async (admin) => {
        await admin.unsafe(
          `DROP DATABASE IF EXISTS "${localBranchDatabase(name)}" WITH (FORCE)`,
        );
      }),
    list: ({ prefix = "" } = {}) =>
      withAdmin(main, async (admin) => {
        const rows = await admin<{ datname: string; comment: string | null }[]>`
          SELECT datname, shobj_description(oid, 'pg_database') AS comment
          FROM pg_database
          WHERE datname LIKE ${`${LOCAL_BRANCH_PREFIX.replaceAll("_", "\\_")}%`}
          ORDER BY datname`;
        return rows.flatMap(({ datname, comment }) => {
          const name = localBranchName(datname);
          return name?.startsWith(prefix)
            ? [{ name, ...parseComment(comment) }]
            : [];
        });
      }),
  };
}

function parseComment(comment: string | null): Omit<Branch, "name"> {
  try {
    const { parent, createdAt } = JSON.parse(comment ?? "");
    return { parent: parent ?? null, createdAt: String(createdAt) };
  } catch {
    return { parent: null, createdAt: "" };
  }
}

function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
