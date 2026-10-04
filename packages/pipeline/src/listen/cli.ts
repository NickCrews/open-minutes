#!/usr/bin/env -S npx tsx
// The audio tools as a JSON CLI, the way `pnpm tools` exposes the database
// tools:
//
//   pnpm audio                          list the tools, one per line
//   pnpm audio <tool> --schema          print a tool's input as JSON Schema
//   pnpm audio <tool> '<json>'          call it; input may also come on stdin
//   pnpm audio --describe               every tool with its schema, as JSON
//
// Results are JSON (or, for voice_timeline, text) on stdout; progress goes to stderr. A refused call prints
// {"error": "..."} and exits 1. A meeting is a golden fixture name or a
// database meeting id; the database is chosen as everywhere else (--db, else
// $DB, else your branch's local database) and only opened for an id.

import { readFileSync } from "node:fs";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";
import { type DB, getDb, resolveDatabaseUrl } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { goldenRefs, ListenError } from "./meeting";
import { callListenTool, listenContext, parametersOf } from "./tool";
import { listenTools as tools } from "./tools";

loadRootDotEnv();

const args = process.argv.slice(2);
const dbAt = args.indexOf("--db");
const target = dbAt >= 0 ? args.splice(dbAt, 2)[1] : undefined;
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [name, json] = args.filter((a) => !a.startsWith("--"));
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

if (flags.has("--describe")) {
  print(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: parametersOf(t),
    })),
  );
  process.exit(0);
}
if (!name) {
  for (const t of tools) console.log(`${t.name}\t${t.description}`);
  console.log(`\nGolden meetings: ${goldenRefs().join(" ")}`);
  process.exit(0);
}
const tool = tools.find((t) => t.name === name);
if (!tool) {
  print({ error: `No tool "${name}". Run \`pnpm audio\` to list them.` });
  process.exit(1);
}
if (flags.has("--schema")) {
  print(parametersOf(tool));
  process.exit(0);
}

let input: unknown;
try {
  const text = json ?? (process.stdin.isTTY ? "{}" : readFileSync(0, "utf8"));
  input = JSON.parse(text.trim() || "{}");
} catch (err) {
  print({ error: `Input isn't JSON: ${(err as Error).message}` });
  process.exit(1);
}

let client: { end(): Promise<void> } | null = null;
const ctx = listenContext(async (): Promise<DB> => {
  const url = resolveDatabaseUrl(target);
  await prepareDatabase(url);
  const opened = getDb(url);
  client = opened.client;
  return opened.db;
});
try {
  const result = await callListenTool(ctx, tool, input);
  // A tool written for a model to read (voice_timeline) returns text.
  if (typeof result === "string") console.log(result);
  else print(result);
} catch (err) {
  if (!(err instanceof ListenError)) throw err;
  print({ error: err.message });
  process.exitCode = 1;
} finally {
  await (client as { end(): Promise<void> } | null)?.end();
}
