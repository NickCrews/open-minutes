#!/usr/bin/env -S npx tsx
// The tools as a JSON CLI, for any agent with a shell:
//
//   pnpm tools                          list the tools, one per line
//   pnpm tools <tool> --schema          print a tool's input as JSON Schema
//   pnpm tools <tool> '<json>'          call it; input may also come on stdin
//   pnpm tools --describe               every tool with its schema, as JSON
//
// Results are JSON on stdout. A refused call prints {"error": "..."} and
// exits 1. The database is chosen as everywhere else: --db, else $DB, else
// your branch's local database.

import { readFileSync } from "node:fs";
import { getDb, resolveDatabaseUrl } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { callTool, parametersOf, ToolError } from "./tool";
import { tools } from "./tools";

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

const url = resolveDatabaseUrl(target);
await prepareDatabase(url);
const { db, client } = getDb(url);
try {
  print(await callTool(db, tool, input));
} catch (err) {
  if (!(err instanceof ToolError)) throw err;
  print({ error: err.message });
  process.exitCode = 1;
} finally {
  await client.end();
}
