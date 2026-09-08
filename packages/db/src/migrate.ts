import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env") });

const { db, pool } = createDb();
try {
  await migrate(db, { migrationsFolder: path.resolve(here, "../migrations") });
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
