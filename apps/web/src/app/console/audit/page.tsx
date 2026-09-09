"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

/**
 * AUD-001 — append-only audit log viewer with hash-chain integrity check.
 * The log is the anchoring basis (architecture §8): a failed integrity
 * check is a critical security event, surfaced loudly, never dismissible.
 */

interface AuditEvent {
  seq: string;
  id: string;
  ts: string;
  actorType: string;
  actorUserId: string | null;
  actorDisplay: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  correlationId: string | null;
  details: Record<string, unknown> | null;
  eventHash: string;
}

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<{
    ok: boolean;
    checked: number;
    brokenAtSeq?: string;
    reason?: string;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(
    (beforeSeq?: string) => {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (beforeSeq) params.set("beforeSeq", beforeSeq);
      if (action.trim()) params.set("action", action.trim());
      if (resourceType.trim()) params.set("resourceType", resourceType.trim());
      api<{ items: AuditEvent[] }>(`/api/v1/audit/events?${params}`)
        .then((res) => {
          setItems((prev) => (beforeSeq ? [...prev, ...res.items] : res.items));
          setHasMore(res.items.length === PAGE_SIZE);
          setError(null);
        })
        .catch((err) =>
          setError(
            err instanceof ApiError
              ? err.message
              : "Аудит логийг ачаалж чадсангүй · Failed to load",
          ),
        )
        .finally(() => setLoading(false));
    },
    [action, resourceType],
  );
  useEffect(() => load(), [load]);

  async function verifyIntegrity() {
    setVerifying(true);
    setIntegrity(null);
    try {
      setIntegrity(
        await api<{ ok: boolean; checked: number; brokenAtSeq?: string; reason?: string }>(
          "/api/v1/audit/verify-integrity",
          { method: "POST" },
        ),
      );
    } catch {
      setError("Бүрэн бүтний шалгалт амжилтгүй боллоо · Integrity check failed to run");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <>
      <h1>Аудит лог · Audit log</h1>
      <p className="subtitle">
        Нэмэгдэх-л зарчимтай, хэш-гинжээр холбогдсон үйлдлийн бүртгэл — өдрийн
        anchoring-ийн суурь.
      </p>

      <div className="card">
        <div className="btn-row" style={{ marginTop: 0, alignItems: "end" }}>
          <div>
            <label className="field-label" htmlFor="fAction">
              Үйлдэл · Action
            </label>
            <input
              id="fAction"
              className="cert-input"
              style={{ textTransform: "none", letterSpacing: "normal", fontSize: 14, width: 260 }}
              placeholder="ж: credential.issued"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="fResource">
              Обьект · Resource type
            </label>
            <input
              id="fResource"
              className="cert-input"
              style={{ textTransform: "none", letterSpacing: "normal", fontSize: 14, width: 200 }}
              placeholder="ж: credential"
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
            />
          </div>
          <button className="btn-secondary" onClick={() => load()}>
            Шүүх · Filter
          </button>
          <button
            className="btn-secondary"
            style={{ marginLeft: "auto" }}
            disabled={verifying}
            onClick={verifyIntegrity}
          >
            {verifying ? "Шалгаж байна…" : "Гинжийн бүрэн бүтнийг шалгах · Verify chain"}
          </button>
        </div>
        {integrity && (
          <div
            className={`alert ${integrity.ok ? "alert-success" : "alert-error"}`}
            role="status"
          >
            {integrity.ok
              ? `Гинж бүрэн бүтэн — ${integrity.checked} бичлэг шалгагдлаа. · Chain intact (${integrity.checked} events).`
              : `⚠ ГИНЖ ЭВДЭРСЭН — seq ${integrity.brokenAtSeq} (${integrity.reason}). Энэ нь ноцтой аюулгүй байдлын үзэгдэл: хамаарах хугацааны бичлэгүүдийг царцааж, аюулгүй байдлын багт мэдэгдэнэ үү.`}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Seq</th>
              <th>Огноо</th>
              <th>Гүйцэтгэгч</th>
              <th>Үйлдэл</th>
              <th>Обьект</th>
              <th>Үр дүн</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="muted">
                  Тохирох бичлэг алга. · No matching events.
                </td>
              </tr>
            ) : (
              items.map((e) => (
                <FragmentRows
                  key={e.seq}
                  event={e}
                  expanded={expanded === e.seq}
                  onToggle={() => setExpanded(expanded === e.seq ? null : e.seq)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="btn-row">
          <button
            className="btn-secondary"
            disabled={loading}
            onClick={() => load(items[items.length - 1]?.seq)}
          >
            Цааш ачаалах · Load more
          </button>
        </div>
      )}
    </>
  );
}

function FragmentRows({
  event: e,
  expanded,
  onToggle,
}: {
  event: AuditEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td className="mono">{e.seq}</td>
        <td className="muted" style={{ whiteSpace: "nowrap" }}>
          {new Date(e.ts).toLocaleString("mn-MN")}
        </td>
        <td>
          {e.actorDisplay ?? (e.actorUserId ? `${e.actorUserId.slice(0, 8)}…` : e.actorType)}
        </td>
        <td className="mono">{e.action}</td>
        <td>
          {e.resourceType}
          {e.resourceId && (
            <div className="muted mono">{e.resourceId.slice(0, 8)}…</div>
          )}
        </td>
        <td>
          <span
            className={`badge ${e.result === "SUCCESS" ? "badge-success" : e.result === "DENIED" ? "badge-warning" : "badge-error"}`}
          >
            {e.result}
          </span>
        </td>
        <td>
          <button className="btn-secondary" style={{ minHeight: 28, padding: "2px 10px" }} onClick={onToggle}>
            {expanded ? "Хаах" : "Дэлгэрэнгүй"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {JSON.stringify(
                { details: e.details, correlationId: e.correlationId, eventHash: e.eventHash },
                null,
                2,
              )}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
