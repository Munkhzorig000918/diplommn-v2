"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface Health {
  status: "OPERATIONAL" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latencyMs?: number;
  error?: string;
}
interface Overview {
  checkedAt: string;
  integrations: Record<string, Health>;
  queues: Record<string, Record<string, number>>;
}
interface FailedJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  failedReason: string;
  timestamp: number;
}

const HEALTH_BADGE: Record<Health["status"], string> = {
  OPERATIONAL: "badge-success",
  DEGRADED: "badge-warning",
  DOWN: "badge-error",
  UNKNOWN: "badge-neutral",
};
const HEALTH_LABEL: Record<Health["status"], string> = {
  OPERATIONAL: "Хэвийн · Operational",
  DEGRADED: "Удаашралтай · Degraded",
  DOWN: "Ажиллахгүй · Down",
  UNKNOWN: "Тодорхойгүй · Unknown",
};
const INTEGRATION_LABEL: Record<string, string> = {
  postgres: "PostgreSQL (NDC)",
  redis: "Redis / дараалал",
  objectStorage: "Объект хадгалалт (PDF)",
};

/** OPS-001 / JOB-002 (lite) — integration health, queue depth, dead-letter retry. */
export default function OpsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<Record<string, FailedJob[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const ov = await api<Overview>("/api/v1/ops/overview");
      setOverview(ov);
      const entries: Record<string, FailedJob[]> = {};
      for (const q of Object.keys(ov.queues)) {
        const res = await api<{ items: FailedJob[] }>(
          `/api/v1/ops/jobs/failed?queue=${q}`,
        );
        entries[q] = res.items;
      }
      setFailed(entries);
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "Энэ хэсэгт хандах эрх байхгүй. · You do not have access to this area."
          : "Үйл ажиллагааны мэдээллийг ачаалж чадсангүй · Failed to load ops data",
      );
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  async function retry(queue: string, jobId: string) {
    setNotice(null);
    try {
      await api(`/api/v1/ops/jobs/${queue}/${jobId}/retry`, { method: "POST" });
      setNotice(`Ажил ${jobId} дахин дараалалд орлоо. · Job requeued.`);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Дахин оролдолт амжилтгүй");
    }
  }

  if (error && !overview) return <div className="alert alert-error">{error}</div>;
  if (!overview) return <p className="muted">Ачаалж байна… · Loading…</p>;

  return (
    <>
      <h1>Үйл ажиллагааны тойм</h1>
      <p className="subtitle">
        Сүүлд шалгасан: {new Date(overview.checkedAt).toLocaleString("mn-MN")} ·
        15 сек тутам шинэчлэгдэнэ. · Refreshes every 15s.
      </p>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
        {Object.entries(overview.integrations).map(([key, h]) => (
          <div className="card" key={key} style={{ marginBottom: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              {INTEGRATION_LABEL[key] ?? key}
            </div>
            <span className={`badge ${HEALTH_BADGE[h.status]}`}>{HEALTH_LABEL[h.status]}</span>
            <div className="muted" style={{ marginTop: 8 }}>
              {h.latencyMs !== undefined ? `${h.latencyMs} ms` : ""}
              {h.error ? ` — ${h.error}` : ""}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Дараалал · Queues</h2>
      <div className="table-wrap" style={{ marginBottom: 24 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Дараалал</th>
              <th>Хүлээгдэж буй</th>
              <th>Идэвхтэй</th>
              <th>Дууссан</th>
              <th>Амжилтгүй</th>
              <th>Хойшлогдсон</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(overview.queues).map(([name, counts]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td>{counts.waiting ?? 0}</td>
                <td>{counts.active ?? 0}</td>
                <td>{counts.completed ?? 0}</td>
                <td style={{ color: (counts.failed ?? 0) > 0 ? "var(--color-error)" : undefined, fontWeight: (counts.failed ?? 0) > 0 ? 700 : undefined }}>
                  {counts.failed ?? 0}
                </td>
                <td>{counts.delayed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 12 }}>
        Амжилтгүй ажлууд · Failed jobs
      </h2>
      {Object.entries(failed).every(([, jobs]) => jobs.length === 0) ? (
        <div className="card">Амжилтгүй ажил алга. · No failed jobs. ✓</div>
      ) : (
        Object.entries(failed).map(([queue, jobs]) =>
          jobs.length === 0 ? null : (
            <div className="table-wrap" key={queue} style={{ marginBottom: 16 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{queue}</th>
                    <th>Оролдлого</th>
                    <th>Шалтгаан</th>
                    <th>Огноо</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="mono">
                        {j.name}
                        <div className="muted">{String(j.data.credentialId ?? j.id)}</div>
                      </td>
                      <td>{j.attemptsMade}</td>
                      <td style={{ maxWidth: 320, color: "var(--color-error)" }}>{j.failedReason}</td>
                      <td>{new Date(j.timestamp).toLocaleString("mn-MN")}</td>
                      <td>
                        <button className="btn-secondary" onClick={() => retry(queue, j.id)}>
                          Дахин оролдох · Retry
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        )
      )}
    </>
  );
}
