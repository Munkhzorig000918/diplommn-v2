import { createDb } from "@diplommn/db";
import { createStorage } from "@diplommn/storage";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createQueues } from "./queues.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const storage = createStorage();
await storage.ensureBucket();
const queues = createQueues();

const app = await buildServer(db, config, { queues, storage });

const shutdown = async () => {
  await app.close();
  await queues.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.API_PORT, host: config.API_HOST });
