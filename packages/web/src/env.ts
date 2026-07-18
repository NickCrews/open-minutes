/// <reference types="vite/client" />
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { resolveDatabaseUrl } from "@open-minutes/core/db/resolve";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";

// Load .env.local before validating: NODE_ENV below comes from it, and must
// not depend on resolveDatabaseUrl() having run first as a side effect.
if (typeof window === "undefined") loadRootDotEnv();

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    NODE_ENV: z.enum(["development", "test", "production"]),
  },
  clientPrefix: "VITE_",
  client: {
    VITE_PUBLIC_API_URL: z.url(),
  },
  runtimeEnv: {
    // $DB selects the database: a name like "local" or "prod", or a raw
    // postgres:// URL. Resolution is server-only; the client never sees it.
    DATABASE_URL:
      typeof window === "undefined" ? resolveDatabaseUrl() : undefined,
    NODE_ENV: process.env.NODE_ENV,
    VITE_PUBLIC_API_URL: import.meta.env.VITE_PUBLIC_API_URL,
  },
});
