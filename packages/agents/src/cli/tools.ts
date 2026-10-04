// `om tools`: the tools as a JSON CLI, for any agent with a shell:
//
//   pnpm om tools                       list the tools, one per line
//   pnpm om tools <tool> --schema       print a tool's input as JSON Schema
//   pnpm om tools <tool> '<json>'       call it; input may also come on stdin
//   pnpm om tools --describe            every tool with its schema, as JSON
//
// Results are JSON on stdout; progress goes to stderr. A refused call prints
// {"error": "..."} and exits 1. The database is chosen as everywhere else:
// --db, else $DB, else your branch's local database. It's opened on the first
// call that needs it.

import { readFileSync } from "node:fs";
import { getDb, resolveDatabaseUrl } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { toolContext } from "../context";
import { callTool, parametersOf, ToolError } from "../tool";
import { tools } from "../tools";

/** Run `om tools` with the arguments that follow `tools`. */
export async function runTools(argv: string[]): Promise<void> {
  const args = [...argv];
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
    return;
  }
  if (!name) {
    for (const t of tools) console.log(`${t.name}\t${t.description}`);
    return;
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    print({ error: `No tool "${name}". Run \`pnpm om tools\` to list them.` });
    process.exitCode = 1;
    return;
  }
  if (flags.has("--schema")) {
    print(parametersOf(tool));
    return;
  }

  let input: unknown;
  try {
    const text = json ?? (process.stdin.isTTY ? "{}" : readFileSync(0, "utf8"));
    input = JSON.parse(text.trim() || "{}");
  } catch (err) {
    print({ error: `Input isn't JSON: ${(err as Error).message}` });
    process.exitCode = 1;
    return;
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
}
