import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://diplommn:diplommn_dev@localhost:5433/diplommn",
  },
  strict: true,
  verbose: true,
});
