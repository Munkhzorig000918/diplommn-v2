"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, API_URL, ApiError } from "@/lib/api";

interface RefItem {
  id: string;
  code: string;
  nameMn: string;
}
interface Batch {
  id: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdAt: string;
}

const BATCH_BADGE: Record<string, string> = {
  READY_FOR_REVIEW: "badge-info",
  COMPLETED: "badge-success",
  PARTIALLY_COMPLETED: "badge-warning",
  FAILED: "badge-error",
  CANCELLED: "badge-neutral",
};

/** IMP-001/002 — batch list + CSV upload. */
export default function ImportsPage() {
  const [institutions, setInstitutions] = useState<RefItem[]>([]);
  const [types, setTypes] = useState<RefItem[]>([]);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [institutionId, setInstitutionId] = useState("");
  const [credentialTypeId, setCredentialTypeId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<{ items: Batch[] }>("/api/v1/imports")
      .then((res) => setBatches(res.items))
      .catch(() => setError("Багцуудыг ачаалж чадсангүй · Failed to load batches"));
  }, []);

  useEffect(() => {
    reload();
    Promise.all([
      api<{ items: RefItem[] }>("/api/v1/institutions"),
      api<{ items: RefItem[] }>("/api/v1/credential-types"),
    ]).then(([i, t]) => {
      setInstitutions(i.items);
      setTypes(t.items);
    });
  }, [reload]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("institutionId", institutionId);
      form.append("credentialTypeId", credentialTypeId);
      const res = await api<{
        id: string;
        totalRows: number;
        validRows: number;
        errorRows: number;
      }>("/api/v1/imports", { method: "POST", body: form });
      setNotice(
        `Багц үүслээ: нийт ${res.totalRows}, зөв ${res.validRows}, алдаатай ${res.errorRows}. · Batch created.`,
      );
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Байршуулалт амжилтгүй · Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>CSV импорт</h1>
      <p className="subtitle">
        Загварын дагуу CSV байршуулна; алдаатай мөрүүд зөв мөрүүдийг хэзээ ч
        зогсоохгүй. ·{" "}
        <a href={`${API_URL}/api/v1/imports/template.csv`}>Загвар татах · Download template</a>
      </p>

      <form className="card form-grid" onSubmit={upload}>
        <div>
          <label htmlFor="imp-inst">Байгууллага · Institution</label>
          <select id="imp-inst" value={institutionId} onChange={(e) => setInstitutionId(e.target.value)} required>
            <option value="">— сонгох —</option>
            {institutions.map((i) => (
              <option key={i.id} value={i.id}>{i.code} — {i.nameMn}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="imp-type">Баримтын төрөл · Credential type</label>
          <select id="imp-type" value={credentialTypeId} onChange={(e) => setCredentialTypeId(e.target.value)} required>
            <option value="">— сонгох —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.code} — {t.nameMn}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="imp-file">CSV файл (хамгийн ихдээ 5MB, 5000 мөр)</label>
          <input
            id="imp-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}
        <div>
          <button className="btn-primary" type="submit" disabled={busy || !file} style={{ marginTop: 0 }}>
            Байршуулж шалгах · Upload & validate
          </button>
        </div>
      </form>

      <h2 style={{ fontSize: 18, margin: "8px 0 12px" }}>Багцууд · Batches</h2>
      {batches === null ? (
        <p className="muted">Ачаалж байна…</p>
      ) : batches.length === 0 ? (
        <div className="card">Багц алга. · No batches yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Багц · Batch</th>
                <th>Төлөв · Status</th>
                <th>Нийт</th>
                <th>Зөв</th>
                <th>Алдаатай</th>
                <th>Огноо</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/console/imports/${b.id}`} className="mono">
                      {b.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td>
                    <span className={`badge ${BATCH_BADGE[b.status] ?? "badge-neutral"}`}>{b.status}</span>
                  </td>
                  <td>{b.totalRows}</td>
                  <td>{b.validRows}</td>
                  <td>{b.errorRows}</td>
                  <td>{new Date(b.createdAt).toLocaleString("mn-MN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
