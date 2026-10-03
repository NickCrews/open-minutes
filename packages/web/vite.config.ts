import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";
import { prepareDevDatabase } from "./vite/dev-database";

// Load this config with `--configLoader runner`, as the package.json scripts do.
// The dev-database import pulls in @open-minutes/db's TypeScript source. Vite's
// default config loader hands workspace packages to plain node, which can't
// resolve their extensionless imports, so bare `npx vite` fails with
// ERR_MODULE_NOT_FOUND (e.g. db/src/schema). Use `pnpm dev` / `pnpm build`, or
// pass the flag yourself.
export default defineConfig(async ({ command, isPreview }) => {
  // Only the dev server: builds must not touch (or bake in) a database URL.
  const databaseUrl =
    command === "serve" && !isPreview ? await prepareDevDatabase() : undefined;
  loadRootDotEnv();
  return {
    define: {
      // Public, and read by the browser (see src/lib/audio-store.ts), so it's
      // baked into the build rather than read from the Worker's environment.
      "import.meta.env.OBJECT_STORE_PUBLIC_URL": JSON.stringify(
        process.env.OBJECT_STORE_PUBLIC_URL ?? "",
      ),
    },
    server: {
      port: 3000,
    },
    resolve: {
      alias: {
        "~": path.resolve(import.meta.dirname, "src"),
      },
    },
    plugins: [
      tailwindcss(),
      // Runs the SSR environment in workerd (dev) and emits a Workers bundle
      // (build). Must come before tanstackStart().
      cloudflare({
        viteEnvironment: { name: "ssr" },
        // workerd can't read .env.local or .git to resolve the target itself.
        config: databaseUrl
          ? { vars: { DATABASE_URL: databaseUrl } }
          : undefined,
      }),
      tanstackStart(),
      solidPlugin({ ssr: true }),
    ],
  };
});
