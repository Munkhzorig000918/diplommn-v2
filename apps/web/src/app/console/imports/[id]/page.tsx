"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, API_URL, ApiError } from "@/lib/api";

interface BatchDetail {
  batch: {
    id: string;
    status: string;
    totalRows: number;
    validRows: number;
    errorRows: number;
    createdAt: string;
  };
  rows: {
    id: string;
    rowNumber: number;
    raw: Record<string, string>;
    errors: { field: string; message: string }[] | null;
    status: string;
    credentialId: string | null;
  }[];
}

const ROW_BADGE: Record<string, string> = {
  PENDING: "badge-info",
  SUBMITTED: "badge-success",
  ERROR: "badge-error",
  FAILED: "badge-error",
};

/** IMP-004 — batch detail: per-row outcomes, error download, submit. */
export default function ImportBatchPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<BatchDetail>(`/api/v1/imports/${id}?limit=500`)
      .then(setData)
      .catch(() => setError("Багцыг ачаалж чадсангүй · Failed to load batch"));
  }, [id]);
  useEffect(reload, [reload]);

  async function submit() {
    if (
      !window.confirm(
        "Зөв мөрүүдийг зөвшөөрлийн урсгалд илгээх үү? · Submit all valid rows into the approval workflow?",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ submitted: number; failed: number; status: string }>(
        `/api/v1/imports/${id}/submit`,
        { method: "POST" },
      );
      setNotice(
        `Илгээгдсэн: ${res.submitted}, амжилтгүй: ${res.failed}. Төлөв: ${res.status}`,
      );
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Илгээлт амжилтгүй · Submit failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="muted">Ачаалж байна… · Loading…</p>;
  const { batch, rows } = data;

  return (
    <>
      <h1>Импортын багц</h1>
      <p className="subtitle mono">{batch.id}</p>
      <p>
        Нийт {batch.totalRows} · Зөв {batch.validRows} · Алдаатай {batch.errorRows} ·{" "}
        <span className="badge badge-info">{batch.status}</span>
      </p>

      <div className="btn-row">
        {batch.status === "READY_FOR_REVIEW" && (
          <button className="btn-primary" style={{ marginTop: 0 }} onClick={submit} disabled={busy}>
            Зөв мөрүүдийг илгээх · Submit valid rows
          </button>
        )}
        {batch.errorRows > 0 && (
          <a className="btn-secondary" href={`${API_URL}/api/v1/imports/${batch.id}/errors.csv`}>
            Алдааны файл татах · Download errors.csv
          </a>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Мөр</th>
              <th>Төлөв</th>
              <th>Эзэмшигч</th>
              <th>Дугаар</th>
              <th>Алдаа / Холбоос</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.rowNumber}</td>
                <td>
                  <span className={`badge ${ROW_BADGE[r.status] ?? "badge-neutral"}`}>{r.status}</span>
                </td>
                <td>
                  {r.raw.lastName} {r.raw.firstName}
                  <div className="mono muted">{r.raw.registrationNumber}</div>
                </td>
                <td className="mono">{r.raw.credentialNumber}</td>
                <td>
                  {r.errors ? (
                    <ul style={{ paddingLeft: 16, color: "var(--color-error)" }}>
                      {r.errors.map((e, i) => (
                        <li key={i}>
                          <strong>{e.field}</strong>: {e.message}
                        </li>
                      ))}
                    </ul>
                  ) : r.credentialId ? (
                    <Link href={`/console/credentials/${r.credentialId}`}>
                      Баримт нээх · Open credential →
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
