import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
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
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    solidPlugin({ ssr: true }),
  ],
});
