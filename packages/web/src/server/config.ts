import { createServerFn } from "@tanstack/solid-start";

/**
 * The app's configuration, read from the Worker's environment on the server.
 * Plain values are `vars` in wrangler.jsonc; secrets are Worker secrets (see
 * docs/contributing/deploy.md). The browser sees only {@link PublicConfig}.
 */

/** Configuration the browser needs. Never put a secret here. */
export type PublicConfig = {
  /** The blob store's public base URL, which excerpts play audio from. */
  blobStorePublicUrl: string;
};

/** The public configuration, which the root route's loader hands the browser. */
export const fetchPublicConfig = createServerFn({ method: "GET" }).handler(
  (): PublicConfig => ({
    blobStorePublicUrl: required("BLOB_STORE_PUBLIC_URL"),
  }),
);

/** The environment variable `name`, which wrangler.jsonc always sets. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set; see wrangler.jsonc`);
  return value;
}
