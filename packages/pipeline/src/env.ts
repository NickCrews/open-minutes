import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function loadEnv() {
  // Load .env from the workspace root
  config({
    path: join(dirname(fileURLToPath(import.meta.url)), "../../.env.local"),
  });

  // Default to docker-compose's postgres so tests work out of the box after `pnpm db:setup`.
  process.env.DATABASE_URL ??=
    "postgres://postgres:postgres@localhost:5432/open_minutes";
  const env = {
    DATABASE_URL: process.env.DATABASE_URL,
  };
  console.log("Loaded environment variables:", env);
  return env;
}
