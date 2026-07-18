import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/db/resolve.mjs";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations/",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
