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
}

/** HOLD-001 — Миний баримтууд / My credentials. */
export default function PortalHomePage() {
  const [items, setItems] = useState<CredentialItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: CredentialItem[] }>("/api/v1/holder/credentials")
      .then((res) => setItems(res.items))
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (items === null) return <p className="muted">Ачаалж байна… · Loading…</p>;

  return (
    <>
      <h1>Миний баримтууд</h1>
      <p className="subtitle">
        Танд олгогдсон диплом, гэрчилгээнүүд. · Credentials issued to you.
      </p>
      {items.length === 0 ? (
        <div className="card">
          Одоогоор бүртгэлтэй баримт алга. Баримт дутуу гэж үзвэл өөрийн
          сургуульд хандана уу. · No credentials yet — contact your institution
          if something is missing.
        </div>
      ) : (
        items.map((c) => (
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
