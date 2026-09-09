import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@diplommn/db";
import type { ApiConfig } from "./config.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerAuth } from "./plugins/auth.js";
import { registerHolderAuth } from "./plugins/holder-auth.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerUserRoutes } from "./modules/users/routes.js";
import { registerCredentialRoutes } from "./modules/credentials/routes.js";
import { registerLifecycleRoutes } from "./modules/lifecycle/routes.js";
import { registerVerifyRoutes } from "./modules/verify/routes.js";
import { loadLocalDidDocument, registerDidRoutes } from "./modules/did/routes.js";
import { registerAuditRoutes } from "./modules/audit/routes.js";
import {
  registerHolderRoutes,
  type OtpDelivery,
} from "./modules/holder/routes.js";
import { registerImportRoutes } from "./modules/imports/routes.js";
import { registerReferenceRoutes } from "./modules/reference/routes.js";
import { registerFileRoutes } from "./modules/files/routes.js";
import { registerOpsRoutes } from "./modules/ops/routes.js";
import { HemisClient, hemisClientConfigFromEnv } from "@diplommn/hemis";
import { createNotifier } from "@diplommn/notify";
import { createStorage, type Storage } from "@diplommn/storage";
import type { JobQueues } from "./queues.js";

export interface BuildServerOptions {
  logger?: boolean;
  /** OTP delivery provider. Default routes through the notifier; tests inject a capture. */
  otpDelivery?: OtpDelivery;
  /** Job queue producers. Absent (tests) → enqueue is skipped, ops reports unconfigured. */
  queues?: JobQueues | null;
  storage?: Storage;
}

export async function buildServer(
  db: Db,
  config: ApiConfig,
  opts: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: true,
  });
  await app.register(rateLimit, {
    global: false,
    // route-level configs opt in via { config: { rateLimit: ... } }
  });
  await app.register(multipart, {
    attachFieldsToBody: "keyValues",
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  registerErrorHandler(app);
  registerAuth(app, db);
  registerHolderAuth(app, db);

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  const notifier = createNotifier();
  const otpDelivery: OtpDelivery =
    opts.otpDelivery ??
    (async (destination, code) => {
      await notifier.sendEmail(
        destination,
        "Нэвтрэх код — diplom.mn",
        `Таны нэг удаагийн код: ${code} (5 минут хүчинтэй)\nYour one-time login code: ${code} (valid 5 minutes)`,
      );
    });

  const storage = opts.storage ?? createStorage();
  const queues = opts.queues ?? null;

  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, db, notifier);
  const hemisConfig = hemisClientConfigFromEnv(process.env);
  const hemis = hemisConfig ? new HemisClient(hemisConfig) : null;
  registerCredentialRoutes(app, db, queues, hemis);
  registerLifecycleRoutes(app, db, queues);
  const localDidDocument = loadLocalDidDocument(config, app.log);
  registerDidRoutes(app, localDidDocument);
  registerVerifyRoutes(app, db, config, localDidDocument);
  registerAuditRoutes(app, db);
  registerHolderRoutes(app, db, config, otpDelivery);
  registerImportRoutes(app, db);
  registerReferenceRoutes(app, db);
  registerFileRoutes(app, db, storage);
  registerOpsRoutes(app, db, storage, queues);

  return app;
}
