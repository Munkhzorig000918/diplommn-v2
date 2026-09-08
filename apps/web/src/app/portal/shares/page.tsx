"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface ShareItem {
  id: string;
  certificateId: string | null;
  credentialType: string;
  status: string;
  expiresAt: string;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
}

/** HOLD-005/006 — Миний хуваалцалтууд / My shares (list + revoke). */
export default function SharesPage() {
  const [items, setItems] = useState<ShareItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ items: ShareItem[] }>("/api/v1/holder/shares")
      .then((res) => setItems(res.items))
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"));
  }, []);
  useEffect(reload, [reload]);

  async function revoke(id: string) {
    if (
      !window.confirm(
        "Энэ холбоосыг хүчингүй болгох уу? Хүлээн авагчид дахин нээгдэхгүй. · Revoke this link? Recipients will no longer be able to open it.",
      )
    ) {
      return;
    }
    await api(`/api/v1/holder/shares/${id}/revoke`, { method: "POST" });
    reload();
  }

  if (error) return <div className="alert alert-error">{error}</div>;
  if (items === null) return <p className="muted">Ачаалж байна… · Loading…</p>;

  return (
    <>
      <h1>Миний хуваалцалтууд</h1>
      <p className="subtitle">
        Холбоосын төлөв нь баримтын хүчинтэй байдлаас тусдаа. · Link status is
        independent of credential validity.
      </p>
      {items.length === 0 ? (
        <div className="card">
          Одоогоор хуваалцсан холбоос алга. · No share links yet.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Баримт · Credential</th>
                <th>Төлөв · Status</th>
                <th>Дуусах · Expires</th>
                <th>Хандалт · Views</th>
                <th>Сүүлд нээгдсэн · Last opened</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.credentialType}
                    {s.certificateId && (
                      <div className="mono muted">{s.certificateId}</div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${s.status === "ACTIVE" ? "badge-success" : s.status === "REVOKED" ? "badge-error" : "badge-neutral"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td>{new Date(s.expiresAt).toLocaleDateString("mn-MN")}</td>
                  <td>{s.accessCount}</td>
                  <td>
                    {s.lastAccessedAt
                      ? new Date(s.lastAccessedAt).toLocaleString("mn-MN")
                      : "—"}
                  </td>
                  <td>
                    {s.status === "ACTIVE" && (
                      <button className="btn-danger" onClick={() => revoke(s.id)}>
                        Хүчингүй болгох · Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
