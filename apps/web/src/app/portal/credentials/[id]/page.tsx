"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, API_URL, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/api";

interface Detail {
  credential: {
    id: string;
    certificateId: string | null;
    credentialNumber: string | null;
    lifecycleStatus: string;
    issuedAt: string | null;
    institution: { nameMn: string; nameEn: string } | null;
    credentialType: { nameMn: string; nameEn: string } | null;
    claims: Record<string, unknown>;
    pdfAvailable: boolean;
  };
  shares: {
    id: string;
    status: string;
    expiresAt: string;
    accessCount: number;
    createdAt: string;
  }[];
}

interface NewShare {
  shareId: string;
  url: string;
  expiresAt: string;
}

/** HOLD-002/003/004 — credential detail + privacy-preserving share/QR. */
export default function HolderCredentialPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [newShare, setNewShare] = useState<NewShare | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<Detail>(`/api/v1/holder/credentials/${id}`)
      .then(setData)
      .catch(() => setError("Баримтыг ачаалж чадсангүй · Failed to load"));
  }, [id]);
  useEffect(reload, [reload]);

  async function downloadProofBundle() {
    try {
      const bundle = await api<Record<string, unknown>>(
        `/api/v1/holder/credentials/${id}/proof-bundle`,
      );
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `diplom-mn-proof-${id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setError(
        "Нотолгооны багц бэлэн болоогүй байна — гарын үсэг зурагдсаны дараа боломжтой. · The proof bundle is not ready yet (credential not signed).",
      );
    }
  }

  async function createShare() {
    setBusy(true);
    try {
      const share = await api<NewShare>(
        `/api/v1/holder/credentials/${id}/shares`,
        { method: "POST", body: JSON.stringify({ expiresInDays }) },
      );
      setNewShare(share);
      // QR encodes only the share URL — never claims or PII (D2V2 §18).
      setQrDataUrl(
        await QRCode.toDataURL(share.url, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 240,
          color: { dark: "#101828", light: "#ffffff" },
        }),
      );
      reload();
    } catch {
      setError("Хуваалцах холбоос үүсгэж чадсангүй · Failed to create share");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="muted">Ачаалж байна… · Loading…</p>;
  const c = data.credential;

  return (
    <>
      <h1>{c.credentialType?.nameMn ?? "Баримт"}</h1>
      <p className="subtitle">
        {c.institution?.nameMn}
        {c.credentialNumber ? ` · №${c.credentialNumber}` : ""}
      </p>
      <p>
        <span className={`badge ${STATUS_BADGE_CLASS[c.lifecycleStatus] ?? "badge-neutral"}`}>
          {STATUS_LABELS[c.lifecycleStatus] ?? c.lifecycleStatus}
        </span>
      </p>

      <section className="card" style={{ marginTop: 16 }}>
        <dl className="claims-list">
          {c.certificateId && (
            <>
              <dt>Сертификатын дугаар · Certificate ID</dt>
              <dd className="mono">{c.certificateId}</dd>
            </>
          )}
          {Object.entries(c.claims).map(([k, v]) => (
            <FragmentRow key={k} label={k} value={String(v)} />
          ))}
          {c.issuedAt && (
            <>
              <dt>Олгосон огноо · Issued</dt>
              <dd>{new Date(c.issuedAt).toLocaleDateString("mn-MN")}</dd>
            </>
          )}
        </dl>
        {c.certificateId && (
          <p style={{ marginTop: 16 }}>
            <a
              href={`/verify/${c.certificateId.replaceAll("-", "")}`}
              target="_blank"
              rel="noreferrer"
            >
              Нээлттэй баталгаажуулалтаар шалгах · Check via public verification ↗
            </a>
          </p>
        )}
        <div className="btn-row">
          {c.pdfAvailable ? (
            <a
              className="btn-secondary"
              href={`${API_URL}/api/v1/holder/credentials/${c.id}/pdf`}
            >
              PDF татах · Download PDF
            </a>
          ) : (
            <span className="muted">
              PDF бэлтгэгдэж байна — хэдэн хормын дараа дахин шалгана уу.
            </span>
          )}
          <button
            className="btn-secondary"
            type="button"
            onClick={downloadProofBundle}
          >
            Цахим баримт (VC) татах · Download proof bundle
          </button>
        </div>
        <p className="field-hint">
          Нотолгооны багц нь гарын үсэгтэй цахим баримт + нийтийн нотолгоог
          агуулах бөгөөд diplom.mn-ээс хамааралгүйгээр шалгагдана. · The proof
          bundle verifies independently of diplom.mn.
        </p>
      </section>

      {c.lifecycleStatus === "ISSUED" && (
        <section className="card">
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>
            Хуваалцах · Share
          </h2>
          <p className="muted" style={{ marginBottom: 12 }}>
            Хугацаатай, хүчингүй болгож болдог холбоос үүснэ. Хүлээн авагч
            зөвхөн баталгаажуулалтын үр дүнг харна. · Creates an expiring,
            revocable link; the recipient sees only the verification result.
          </p>
          <div className="btn-row" style={{ alignItems: "center" }}>
            <label>
              Хүчинтэй хугацаа · Valid for{" "}
              <select
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                <option value={1}>1 хоног · 1 day</option>
                <option value={7}>7 хоног · 7 days</option>
                <option value={30}>30 хоног · 30 days</option>
                <option value={90}>90 хоног · 90 days</option>
              </select>
            </label>
            <button className="btn-primary" style={{ marginTop: 0 }} onClick={createShare} disabled={busy}>
              Холбоос үүсгэх · Create link
            </button>
          </div>

          {newShare && (
            <div className="alert alert-success" style={{ marginTop: 16 }}>
              <p style={{ fontWeight: 600 }}>
                Холбоос бэлэн боллоо (зөвхөн нэг удаа харагдана) · Link ready
                (shown only once):
              </p>
              <p className="mono" style={{ wordBreak: "break-all", margin: "8px 0" }}>
                {newShare.url}
              </p>
              {qrDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="Хуваалцах QR код · Share QR code"
                  width={240}
                  height={240}
                  style={{ background: "#fff", padding: 8, borderRadius: 8 }}
                />
              )}
              <p className="muted">
                Дуусах хугацаа · Expires:{" "}
                {new Date(newShare.expiresAt).toLocaleString("mn-MN")}
              </p>
            </div>
          )}

          {data.shares.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Төлөв · Status</th>
                    <th>Дуусах · Expires</th>
                    <th>Хандалт · Views</th>
                    <th>Үүсгэсэн · Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shares.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className={`badge ${s.status === "ACTIVE" ? "badge-success" : s.status === "REVOKED" ? "badge-error" : "badge-neutral"}`}>
                          {s.status}
                        </span>
                      </td>
                      <td>{new Date(s.expiresAt).toLocaleDateString("mn-MN")}</td>
                      <td>{s.accessCount}</td>
                      <td>{new Date(s.createdAt).toLocaleDateString("mn-MN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  const labels: Record<string, string> = {
    program: "Хөтөлбөр · Program",
    degree: "Зэрэг · Degree",
    awardedDate: "Төгссөн огноо · Awarded",
    holderName: "Эзэмшигч · Holder",
    institution: "Байгууллага · Institution",
    credentialNumber: "Баримтын дугаар · Document №",
  };
  return (
    <>
      <dt>{labels[label] ?? label}</dt>
      <dd>{value}</dd>
    </>
  );
}
