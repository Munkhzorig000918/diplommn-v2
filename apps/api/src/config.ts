import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env"), quiet: true });

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  SESSION_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  PUBLIC_HOLDER_NAME_DISCLOSURE: z
    .enum(["masked", "full", "none"])
    .default("masked"),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid API configuration: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return { ...parsed.data, ...overrides };
}
