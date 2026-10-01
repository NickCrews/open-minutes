import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Cluster-level plumbing shared by the dev harness (./ensure) and the test
// harness (./testing): talking to the always-present `postgres` database to
// CREATE/DROP databases, and starting docker-compose's postgres on demand.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when the URL points at this machine (docker-compose's postgres). */
export function isLocalUrl(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/**
 * The direct (unpooled) form of a Neon URL; other URLs are returned as is.
 * Neon's pooler runs PgBouncer in transaction mode, where session state like
 * advisory locks can stay stuck on a pooled backend after we disconnect — so
 * migrations and locks must bypass it. Neon names the pooler host by adding
 * "-pooler" to the endpoint id.
 */
export function directUrl(url: string): string {
  const u = new URL(url);
  if (!u.hostname.endsWith(".neon.tech")) return url;
  const [endpoint, ...rest] = u.hostname.split(".");
  if (!endpoint?.endsWith("-pooler")) return url;
  u.hostname = [endpoint.slice(0, -"-pooler".length), ...rest].join(".");
  return u.toString();
}

/** The same server, but a different database. */
export function urlForDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The database name a URL connects to. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

// Every database name we generate matches this; quoting is then trivial and
// interpolating into DDL (which cannot be parameterized) is safe.
export function assertSafeName(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  return name;
}

/** Runs `fn` with a connection to the `postgres` db, always disconnecting. */
export async function withAdmin<T>(
  base: string,
  fn: (admin: postgres.Sql) => Promise<T>,
): Promise<T> {
  const admin = postgres(urlForDatabase(base, "postgres"), {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export async function databaseExists(
  admin: postgres.Sql,
  name: string,
): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  return rows.length > 0;
}

function canConnect(host: string, port: number, timeoutMs = 500) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function findComposeDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "docker-compose.yml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not find docker-compose.yml above " + import.meta.url,
      );
    }
    dir = parent;
  }
  return dir;
}

// Memoized per process: after the first call, callers pay nothing to "ensure".
const postgresReady = new Map<string, Promise<void>>();

/**
 * Guarantees a postgres is listening at the URL's host:port, starting
 * docker-compose's postgres service if the URL is local and down.
 */
export function ensurePostgresRunning(url: string): Promise<void> {
  const u = new URL(url);
  const key = `${u.hostname}:${u.port}`;
  let ready = postgresReady.get(key);
  if (!ready) {
    ready = startPostgresIfDown(url);
    // Only successes stay memoized: a transient failure (say, a docker
    // hiccup) shouldn't poison every later call in the process.
    ready.catch(() => postgresReady.delete(key));
    postgresReady.set(key, ready);
  }
  return ready;
}

/**
 * True once the server completes a postgres handshake. An open port alone
 * isn't enough: docker publishes the port before postgres listens (and the
 * image restarts postgres once after initdb), and connections in that window
 * are reset. Any error the server itself sends, other than "starting up",
 * means it is up (a wrong password, say, is the caller's to report).
 */
async function postgresAnswers(base: string): Promise<boolean> {
  const sql = postgres(urlForDatabase(base, "postgres"), {
    max: 1,
    connect_timeout: 2,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    return err instanceof postgres.PostgresError && err.code !== "57P03";
  } finally {
    await sql.end({ timeout: 0 });
  }
}

async function startPostgresIfDown(base: string): Promise<void> {
  const url = new URL(base);
  const host = url.hostname;
  const port = Number(url.port || 5432);

  if (!isLocalUrl(base)) {
    if (await canConnect(host, port)) return;
    throw new Error(
      `Database at ${host}:${port} is unreachable, and it isn't local so I won't docker-compose it up.`,
    );
  }

  if (await postgresAnswers(base)) return;

  console.error(`No postgres on ${host}:${port} — starting docker compose...`);
  // Capture output and tolerate failure: concurrent processes can race this
  // command, and the loser's spurious "container name already in use" error
  // doesn't matter as long as postgres comes up below.
  const compose = spawnSync(
    "docker",
    ["compose", "up", "-d", "--wait", "postgres"],
    { cwd: findComposeDir(), encoding: "utf8" },
  );

  const deadline = Date.now() + 60_000;
  while (!(await postgresAnswers(base))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for postgres on ${host}:${port}. \`docker compose up\` said:\n${compose.error?.message ?? `${compose.stdout}${compose.stderr}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
