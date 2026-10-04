#!/usr/bin/env -S npx tsx
// The tools as a JSON CLI, for any agent with a shell:
//
//   pnpm tools                          list the tools, one per line
//   pnpm tools <tool> --schema          print a tool's input as JSON Schema
//   pnpm tools <tool> '<json>'          call it; input may also come on stdin
//   pnpm tools --describe               every tool with its schema, as JSON
//
// Results are JSON on stdout; progress goes to stderr. A refused call prints
// {"error": "..."} and exits 1. The database is chosen as everywhere else:
// --db, else $DB, else your branch's local database. It's only opened for a
// tool that needs it: the audio tools on a golden fixture don't.

import { readFileSync } from "node:fs";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";
import { getDb, resolveDatabaseUrl } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { goldenRefs } from "./audio/meeting";
import { toolContext } from "./context";
import { callTool, parametersOf, ToolError } from "./tool";
import { tools } from "./tools";

// The audio tools read OBJECT_STORE_PUBLIC_URL to download a meeting's audio.
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
  print({ error: `No tool "${name}". Run \`pnpm tools\` to list them.` });
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
const ctx = toolContext(async () => {
  const url = resolveDatabaseUrl(target);
  await prepareDatabase(url);
  const opened = getDb(url);
  client = opened.client;
  return opened.db;
});
try {
  print(await callTool(ctx, tool, input));
} catch (err) {
  if (!(err instanceof ToolError)) throw err;
  print({ error: err.message });
  process.exitCode = 1;
} finally {
  await (client as { end(): Promise<void> } | null)?.end();
}
