import { createServerFn } from "@tanstack/solid-start";

/**
 * The app's configuration comes from one place: the Worker's environment, read
 * here on the server at runtime.
 *
 * - Plain values (public URLs and the like) are `vars` in wrangler.jsonc, so
 *   dev, PR previews and production all get them from that one file.
 * - Secrets (DATABASE_URL) are Worker secrets: .env.local in dev (see
 *   vite.config.ts), `--secrets-file` for previews, and set once on the
 *   production Worker. See docs/contributing/deploy.md.
 *
 * The browser sees only what {@link PublicConfig} hands it.
 */

/** Configuration the browser needs. Never put a secret here. */
export type PublicConfig = {
  /**
   * The object store's public base URL, which excerpts play audio from (see
   * `@open-minutes/youtube/store`). Always set: wrangler.jsonc has it.
   */
  objectStorePublicUrl: string;
};

/**
 * The public configuration, for the root route's loader to hand the browser
 * with the first page.
 */
export const fetchPublicConfig = createServerFn({ method: "GET" }).handler(
  (): PublicConfig => ({
    objectStorePublicUrl: required("OBJECT_STORE_PUBLIC_URL"),
  }),
);

/** The environment variable `name`, which wrangler.jsonc always sets. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set; see wrangler.jsonc`);
  return value;
}
