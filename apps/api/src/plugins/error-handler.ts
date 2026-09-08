import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError, ErrorCode } from "@diplommn/shared";

/**
 * Consistent error envelope; never leaks stack traces or internals.
 * `{ error: { code, message, details?, correlationId } }`
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const correlationId = request.id;

    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
          correlationId,
        },
      });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: ErrorCode.ValidationError,
          message: "Request validation failed",
          details: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
          correlationId,
        },
      });
    }

    // @fastify/rate-limit sets statusCode 429
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: ErrorCode.RateLimited,
          message: "Too many requests, please retry later",
          correlationId,
        },
      });
    }

    request.log.error({ err, correlationId }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: ErrorCode.Internal,
        message: "Internal server error",
        correlationId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: ErrorCode.NotFound,
        message: "Route not found",
        correlationId: request.id,
      },
    });
  });
}
