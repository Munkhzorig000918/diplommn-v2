import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // DB integration tests run sequentially against a live Postgres.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
