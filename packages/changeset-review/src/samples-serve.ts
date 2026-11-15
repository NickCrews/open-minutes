// Serves the made-up changesets of samples.ts as review pages, to work on the
// review page without a database or an issue:
//
//   pnpm --filter @open-minutes/changeset-review samples [--port 4401]
//
// $PORT sets the port too.
//
// The script runs under `vpx --watch`, which restarts it when render.ts,
// samples.ts or anything else it imports changes; client.js is read on every
// request. Each page polls /__version and reloads itself when either changed.

import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderPage } from "./render";
import { samples } from "./samples";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "4401" },
  },
});
const port = Number(values.port);

const CLIENT = new URL("./client.js", import.meta.url);
const started = Date.now().toString(36);
/** Changes when the server restarts or client.js changes. */
const version = () => `${started}-${statSync(CLIENT).mtimeMs}`;

const RELOAD = `<script>
(() => {
  const loaded = ${JSON.stringify("__VERSION__")};
  setInterval(async () => {
    try {
      const now = await (await fetch("/__version")).text();
      if (now !== loaded) location.reload();
    } catch {}
  }, 1000);
})();
</script>`;

const esc = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const TABS_STYLE = `<style>
.samples-tabs{position:sticky;top:0;z-index:100;display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;margin:0 0 1rem;padding:.5rem 1rem;font:13px/1.4 system-ui,sans-serif;background:#f4f4f5;border-bottom:1px solid #d4d4d8}
.samples-tabs a{padding:.3rem .75rem;border-radius:.375rem;color:#3f3f46;text-decoration:none}
.samples-tabs a:hover{background:#e4e4e7}
.samples-tabs a[aria-current=page]{background:#18181b;color:#fafafa}
.samples-tabs .about{flex-basis:100%;padding:.25rem .75rem 0;color:#71717a}
@media (prefers-color-scheme:dark){
.samples-tabs{background:#18181b;border-color:#3f3f46}
.samples-tabs a{color:#d4d4d8}
.samples-tabs a:hover{background:#27272a}
.samples-tabs a[aria-current=page]{background:#fafafa;color:#18181b}
.samples-tabs .about{color:#a1a1aa}
}
</style>`;

/** A bar of tabs, one per sample and one for the index, with `current`'s description under it. */
function tabs(current: string | null): string {
  const all = samples();
  const tab = (href: string, label: string, on: boolean, title = "") =>
    `<a href="${href}"${on ? ' aria-current="page"' : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</a>`;
  const about = all.find((s) => s.name === current);
  return `${TABS_STYLE}<nav class="samples-tabs">${tab("/", "All", current === null)}${all
    .map((s) => tab(`/${s.name}`, s.name, s.name === current, s.description))
    .join(
      "",
    )}${about ? `<a href="/${about.name}.json">json</a><div class="about">${esc(about.description)}</div>` : ""}</nav>`;
}

function index(): string {
  const items = samples()
    .map(
      (s) =>
        `<li><a href="/${s.name}">${s.name}</a> (<a href="/${s.name}.json">json</a>): ${esc(s.description)}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Changeset samples</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0}main{max-width:50rem;margin:2rem auto;padding:0 1rem}li{margin:.5rem 0}</style>
</head>
<body>
${tabs(null)}
<main>
<h1>Changeset samples</h1>
<p>Made-up changesets from <code>src/samples.ts</code>, rendered by <code>src/render.ts</code> and <code>src/client.js</code>. Pages reload when those change.</p>
<ul>
${items}
</ul>
</main>
${RELOAD.replace("__VERSION__", version())}
</body>
</html>
`;
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (path === "/__version") {
      res.writeHead(200, { "content-type": "text/plain" }).end(version());
      return;
    }
    if (path === "/") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(index());
      return;
    }
    const m = /^\/([\w-]+?)(\.json)?$/.exec(path);
    const sample = m && samples().find((s) => s.name === m[1]);
    if (!sample) {
      res
        .writeHead(404, { "content-type": "text/plain" })
        .end("no such sample");
      return;
    }
    if (m[2]) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(sample.diff, null, 2));
      return;
    }
    const page = renderPage(sample.diff, readFileSync(CLIENT, "utf8"))
      .replace("<body>", `<body>\n${tabs(sample.name)}`)
      .replace(
        "</body>",
        `${RELOAD.replace("__VERSION__", version())}\n</body>`,
      );
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(page);
  } catch (err) {
    console.error(err);
    res
      .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      .end(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
});

server.listen(port, "localhost", () =>
  console.log(`changeset samples on http://localhost:${port}/`),
);
process.once("SIGINT", () => server.close(() => process.exit(0)));
