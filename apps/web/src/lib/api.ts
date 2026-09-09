export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  correlationId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.message);
    this.status = status;
    this.code = envelope.code;
    this.details = envelope.details;
  }
}

/** Browser-side fetch with session cookies and the API error envelope. */
export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers:
      init.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json", ...init.headers }
        : init.headers,
    ...init,
  });
  if (!res.ok) {
    let envelope: ApiErrorEnvelope = {
      code: "INTERNAL",
      message: "Сервертэй холбогдоход алдаа гарлаа / Request failed",
    };
    try {
      const body = (await res.json()) as { error?: ApiErrorEnvelope };
      if (body.error) envelope = body.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, envelope);
  }
  return (await res.json()) as T;
}

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Ноорог · Draft",
  PENDING_APPROVAL: "Зөвшөөрөл хүлээж байна · Pending approval",
  RETURNED: "Буцаагдсан · Returned",
  REJECTED: "Татгалзсан · Rejected",
  APPROVED: "Батлагдсан · Approved",
  ISSUED: "Олгогдсон · Issued",
  REVOCATION_PENDING: "Цуцлалт хийгдэж байна · Revocation processing",
  REVOKED: "Цуцлагдсан · Revoked",
  SUPERSEDED: "Шинэ хувилбараар солигдсон · Superseded",
  CANCELLED: "Цуцалсан ноорог · Cancelled",
};

export const SOURCE_VALIDATION_LABELS: Record<string, string> = {
  NOT_CHECKED: "Шалгаагүй",
  CHECKING: "Шалгаж байна",
  MATCHED: "Тохирсон",
  MISMATCH: "Зөрүүтэй",
  ATTESTATION_INVALID: "Аттестат буруу",
  UNAVAILABLE: "Шалгах боломжгүй",
  STALE: "Хуучирсан",
};

export const SOURCE_VALIDATION_BADGE: Record<string, string> = {
  NOT_CHECKED: "badge-neutral",
  CHECKING: "badge-info",
  MATCHED: "badge-success",
  MISMATCH: "badge-error",
  ATTESTATION_INVALID: "badge-error",
  UNAVAILABLE: "badge-warning",
  STALE: "badge-warning",
};

export const CASE_TYPE_LABELS: Record<string, string> = {
  REVOKE: "Цуцлах · Revoke",
  CORRECT: "Засварлах · Correct",
  REISSUE: "Дахин олгох · Reissue",
};

export const CASE_STATUS_LABELS: Record<string, string> = {
  OPEN: "Нээлттэй · Open",
  APPROVED: "Батлагдсан · Approved",
  REJECTED: "Татгалзсан · Rejected",
  COMPLETED: "Дууссан · Completed",
  CANCELLED: "Цуцалсан · Cancelled",
};

export const CASE_STATUS_BADGE: Record<string, string> = {
  OPEN: "badge-warning",
  APPROVED: "badge-info",
  REJECTED: "badge-error",
  COMPLETED: "badge-success",
  CANCELLED: "badge-neutral",
};

export const STATUS_BADGE_CLASS: Record<string, string> = {
  DRAFT: "badge-neutral",
  PENDING_APPROVAL: "badge-warning",
  RETURNED: "badge-warning",
  REJECTED: "badge-error",
  APPROVED: "badge-info",
  ISSUED: "badge-success",
  REVOCATION_PENDING: "badge-warning",
  REVOKED: "badge-error",
  SUPERSEDED: "badge-info",
  CANCELLED: "badge-neutral",
};
