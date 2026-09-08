/**
 * Consistent API error taxonomy (master prompt §14/§19). Clients always get
 * `{ error: { code, message, details?, correlationId } }` — never stack traces
 * or internal identifiers.
 */
export const ErrorCode = {
  ValidationError: "VALIDATION_ERROR",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  RateLimited: "RATE_LIMITED",
  Internal: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.ValidationError, message, details);
  }
  static unauthorized(message = "Authentication required"): AppError {
    return new AppError(ErrorCode.Unauthorized, message);
  }
  static forbidden(message = "Not allowed"): AppError {
    return new AppError(ErrorCode.Forbidden, message);
  }
  static notFound(message = "Not found"): AppError {
    return new AppError(ErrorCode.NotFound, message);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.Conflict, message, details);
  }
}
