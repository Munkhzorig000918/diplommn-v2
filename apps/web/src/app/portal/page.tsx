"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/api";

interface CredentialItem {
  id: string;
  certificateId: string | null;
  credentialNumber: string | null;
  lifecycleStatus: string;
  issuedAt: string | null;
  institutionNameMn: string;
  typeNameMn: string;
  kind: string;
}

const KIND_TABS: { value: string | null; label: string }[] = [
  { value: null, label: "Бүгд" },
  { value: "DIPLOMA", label: "Диплом" },
  { value: "CERTIFICATE", label: "Гэрчилгээ" },
];

/** HOLD-001 — Миний баримтууд / My credentials (Astra kind tabs). */
export default function PortalHomePage() {
  const [items, setItems] = useState<CredentialItem[] | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: CredentialItem[] }>("/api/v1/holder/credentials")
      .then((res) => setItems(res.items))
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (items === null) return <p className="muted">Ачаалж байна… · Loading…</p>;

  const visible = kind ? items.filter((c) => c.kind === kind) : items;
  const countOf = (v: string | null) =>
    v ? items.filter((c) => c.kind === v).length : items.length;

  return (
    <>
      <h1>Миний баримтууд</h1>
      <p className="subtitle">
        Танд олгогдсон диплом, гэрчилгээнүүд. · Credentials issued to you.
      </p>
      <div className="subnav" role="tablist" aria-label="Төрлийн шүүлт">
        {KIND_TABS.map((t) => (
          <a
            key={t.label}
            role="tab"
            href="#"
            aria-selected={kind === t.value}
            className={kind === t.value ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              setKind(t.value);
            }}
          >
            {t.label} ({countOf(t.value)})
          </a>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="card">
          Одоогоор бүртгэлтэй баримт алга. Баримт дутуу гэж үзвэл өөрийн
          сургуульд хандана уу. · No credentials yet — contact your institution
          if something is missing.
        </div>
      ) : visible.length === 0 ? (
        <div className="card muted">
          Энэ төрөлд баримт алга. · No credentials of this kind.
        </div>
      ) : (
        visible.map((c) => (
          <Link key={c.id} href={`/portal/credentials/${c.id}`} className="cred-card">
            <div className="cred-title">{c.typeNameMn}</div>
            <div className="cred-meta">
              {c.institutionNameMn}
              {c.credentialNumber ? ` · №${c.credentialNumber}` : ""}
              {c.issuedAt
                ? ` · ${new Date(c.issuedAt).toLocaleDateString("mn-MN")}`
                : ""}
            </div>
            <div style={{ marginTop: 8 }}>
              <span className={`badge ${STATUS_BADGE_CLASS[c.lifecycleStatus] ?? "badge-neutral"}`}>
                {STATUS_LABELS[c.lifecycleStatus] ?? c.lifecycleStatus}
              </span>
            </div>
          </Link>
        ))
      )}
    </>
  );
}
