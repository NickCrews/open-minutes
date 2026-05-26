import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@gbos/core/db";
import { seedDatabase } from "./seed";

// Mirror drizzle.config.ts: load .env.local from the workspace root so the seed
// targets the same DATABASE_URL as the migrations.
config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../../.env.local"),
});

const { db, client } = getDb();
try {
  const summary = await seedDatabase(db);
  console.log("Seeded:", summary);
} finally {
  await client.end();
}
