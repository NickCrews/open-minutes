import { getDb } from "@open-minutes/db";
import { seedDatabase } from "./seed";

const { db, client } = getDb();
try {
  const summary = await seedDatabase(db);
  console.log("Seeded:", summary);
} finally {
  await client.end();
}
