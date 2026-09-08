"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/api";

interface ListItem {
  id: string;
  certificateId: string | null;
  credentialNumber: string | null;
  lifecycleStatus: string;
  issuedAt: string | null;
  updatedAt: string;
  institution: { code: string; nameMn: string };
  credentialType: { code: string; nameMn: string };
  holderName: string;
  holderRegNum: string;
}

const TABS = [
  { status: "PENDING_APPROVAL", label: "Зөвшөөрөл хүлээж буй" },
  { status: "DRAFT", label: "Ноорог" },
  { status: "RETURNED", label: "Буцаагдсан" },
  { status: "APPROVED", label: "Батлагдсан" },
  { status: "ISSUED", label: "Олгогдсон" },
  { status: "", label: "Бүгд · All" },
] as const;

/** DASH-001 / CRED-001 (lite) — actionable work queue over the credential registry. */
export default function ConsoleHomePage() {
  const [tab, setTab] = useState<string>("PENDING_APPROVAL");
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    const query = tab ? `?status=${tab}` : "";
    api<{ items: ListItem[]; total: number }>(`/api/v1/credentials${query}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"));
  }, [tab]);

  return (
    <>
      <h1>Ажлын дараалал</h1>
      <p className="subtitle">
        Нийт {total} бичлэг · Хамрах хүрээний дагуу шүүгдсэн. · Scoped to your
        permissions.
      </p>
      <div className="subnav" role="tablist">
        {TABS.map((t) => (
          <a
            key={t.status}
            role="tab"
            aria-selected={tab === t.status}
            className={tab === t.status ? "active" : ""}
            style={{ cursor: "pointer" }}
            onClick={() => setTab(t.status)}
          >
            {t.label}
          </a>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {items === null ? (
        <p className="muted">Ачаалж байна… · Loading…</p>
      ) : items.length === 0 ? (
        <div className="card">
          Энэ төлөвт бичлэг алга. · Nothing in this state.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Эзэмшигч · Holder</th>
                <th>Байгууллага</th>
                <th>Төрөл</th>
                <th>Дугаар · №</th>
                <th>Төлөв · Status</th>
                <th>Шинэчлэгдсэн · Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/console/credentials/${c.id}`}>{c.holderName}</Link>
                    <div className="mono muted">{c.holderRegNum}</div>
                  </td>
                  <td>{c.institution.nameMn}</td>
                  <td>{c.credentialType.nameMn}</td>
                  <td className="mono">{c.credentialNumber ?? "—"}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE_CLASS[c.lifecycleStatus] ?? "badge-neutral"}`}>
                      {STATUS_LABELS[c.lifecycleStatus] ?? c.lifecycleStatus}
                    </span>
                  </td>
                  <td>{new Date(c.updatedAt).toLocaleString("mn-MN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
