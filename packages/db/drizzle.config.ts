import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/resolve.mjs";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./src/migrations/",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
