"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  api,
  SOURCE_VALIDATION_BADGE,
  SOURCE_VALIDATION_LABELS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
} from "@/lib/api";

/**
 * CRED-001 — credentials register (Astra operations console): server-side
 * status filter chips + pagination, dense table, row → detail.
 */

interface Item {
  id: string;
  certificateId: string | null;
  credentialNumber: string | null;
  lifecycleStatus: string;
  sourceValidationStatus: string;
  issuedAt: string | null;
  updatedAt: string;
  institution: { code: string; nameMn: string };
  credentialType: { code: string; nameMn: string };
  holderName: string;
  holderRegNum: string;
}

const PAGE_SIZE = 25;

const FILTERS: { value: string | null; label: string }[] = [
  { value: null, label: "Бүгд" },
  { value: "PENDING_APPROVAL", label: "Зөвшөөрөл хүлээж буй" },
  { value: "DRAFT", label: "Ноорог" },
  { value: "RETURNED", label: "Буцаагдсан" },
  { value: "APPROVED", label: "Батлагдсан" },
  { value: "ISSUED", label: "Олгогдсон" },
  { value: "REVOKED", label: "Цуцлагдсан" },
];

export default function ConsoleCredentialsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    if (status) params.set("status", status);
    api<{ items: Item[]; total: number }>(`/api/v1/credentials?${params}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
        setError(null);
      })
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"))
      .finally(() => setLoading(false));
  }, [status, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <h1>Баримтууд · Credentials</h1>
      <p className="subtitle">
        Бүртгэлтэй диплом, гэрчилгээний нэгдсэн жагсаалт. Нийт: {total}
      </p>

      <div className="subnav" role="tablist" aria-label="Төлөвийн шүүлт">
        {FILTERS.map((f) => (
          <a
            key={f.label}
            role="tab"
            aria-selected={status === f.value}
            className={status === f.value ? "active" : ""}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setStatus(f.value);
              setPage(0);
            }}
          >
            {f.label}
          </a>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Баримтын №</th>
              <th>Эзэмшигч</th>
              <th>Байгууллага</th>
              <th>Төрөл</th>
              <th>Төлөв</th>
              <th>HEMIS</th>
              <th>Шинэчлэгдсэн</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="muted">
                  Ачаалж байна… · Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  {status
                    ? "Энэ шүүлтэд тохирох баримт алга. · No credentials match this filter."
                    : "Баримт бүртгэгдээгүй байна. · No credentials yet."}
                </td>
              </tr>
            ) : (
              items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/console/credentials/${i.id}`} className="mono">
                      {i.credentialNumber ?? i.certificateId ?? i.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>
                    {i.holderName}
                    <div className="muted mono">{i.holderRegNum}</div>
                  </td>
                  <td>{i.institution.nameMn}</td>
                  <td>{i.credentialType.nameMn}</td>
                  <td>
                    <span
                      className={`badge ${STATUS_BADGE_CLASS[i.lifecycleStatus] ?? "badge-neutral"}`}
                    >
                      {STATUS_LABELS[i.lifecycleStatus]?.split(" · ")[0] ??
                        i.lifecycleStatus}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${SOURCE_VALIDATION_BADGE[i.sourceValidationStatus] ?? "badge-neutral"}`}
                    >
                      {SOURCE_VALIDATION_LABELS[i.sourceValidationStatus] ??
                        i.sourceValidationStatus}
                    </span>
                  </td>
                  <td className="muted">
                    {new Date(i.updatedAt).toLocaleString("mn-MN")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="btn-row">
          <button
            className="btn-secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Өмнөх
          </button>
          <span className="muted" style={{ alignSelf: "center" }}>
            Хуудас {page + 1} / {pageCount}
          </span>
          <button
            className="btn-secondary"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Дараах →
          </button>
        </div>
      )}
    </>
  );
}
