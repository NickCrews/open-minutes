import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load .env from the workspace root, regardless of which package vitest runs from.
config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env") });

// Default to docker-compose's postgres so tests work out of the box.
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/open_minutes";
