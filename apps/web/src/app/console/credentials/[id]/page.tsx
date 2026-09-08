"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, API_URL, ApiError, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/api";
import { staffHasRole, useStaff } from "../../layout";

interface Detail {
  credential: {
    id: string;
    certificateId: string | null;
    credentialNumber: string | null;
    lifecycleStatus: string;
    sourceValidationStatus: string;
    claims: Record<string, unknown>;
    submittedSnapshot: Record<string, unknown> | null;
    schemaVersion: string;
    sourceChannel: string;
    contentHash: string | null;
    contentHashAlg: string | null;
    issuedAt: string | null;
    submittedBy: string | null;
    pdfObjectKey: string | null;
    pdfSha256: string | null;
    holder: {
      lastName: string;
      firstName: string;
      registrationNumber: string;
    } | null;
  };
  events: {
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    createdAt: string;
  }[];
}

/** CRED-002 (lite) — credential detail with permitted workflow actions. */
export default function ConsoleCredentialPage() {
  const { id } = useParams<{ id: string }>();
  const staff = useStaff();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<Detail>(`/api/v1/credentials/${id}`)
      .then(setData)
      .catch(() => setError("Баримтыг ачаалж чадсангүй · Failed to load"));
  }, [id]);
  useEffect(reload, [reload]);

  async function action(
    path: string,
    opts: { reasonPrompt?: string; confirm?: string } = {},
  ) {
    let body: string | undefined;
    if (opts.reasonPrompt) {
      const reason = window.prompt(opts.reasonPrompt);
      if (!reason) return;
      body = JSON.stringify({ reason });
    }
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ certificateId?: string }>(
        `/api/v1/credentials/${id}/${path}`,
        { method: "POST", ...(body ? { body } : {}) },
      );
      if (res.certificateId) {
        setNotice(
          `Олгогдлоо · Issued — Certificate ID: ${res.certificateId}`,
        );
      }
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Үйлдэл амжилтгүй · Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="muted">Ачаалж байна… · Loading…</p>;
  const c = data.credential;
  const isOperator = staffHasRole(staff, "operator");
  const isApprover = staffHasRole(staff, "approver");
  const isOwnSubmission = c.submittedBy !== null && c.submittedBy === staff?.id;

  return (
    <>
      <h1>Баримтын дэлгэрэнгүй</h1>
      <p>
        <span className={`badge ${STATUS_BADGE_CLASS[c.lifecycleStatus] ?? "badge-neutral"}`}>
          {STATUS_LABELS[c.lifecycleStatus] ?? c.lifecycleStatus}
        </span>{" "}
        <span className="muted">
          Эх сурвалж: {c.sourceChannel} · Схем v{c.schemaVersion}
        </span>
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="btn-row">
        {isOperator && (c.lifecycleStatus === "DRAFT" || c.lifecycleStatus === "RETURNED") && (
          <button className="btn-primary" style={{ marginTop: 0 }} disabled={busy}
            onClick={() => action("submit", { confirm: "Зөвшөөрөлд илгээх үү? Илгээсний дараа засварлах боломжгүй. · Submit for approval? Claims freeze on submission." })}>
            Зөвшөөрөлд илгээх · Submit
          </button>
        )}
        {isApprover && c.lifecycleStatus === "PENDING_APPROVAL" && (
          <>
            {isOwnSubmission && (
              <span className="alert alert-info" style={{ margin: 0 }}>
                Өөрийн илгээсэн хүсэлтийг батлах боломжгүй. · You cannot approve your own submission.
              </span>
            )}
            {!isOwnSubmission && (
              <button className="btn-primary" style={{ marginTop: 0 }} disabled={busy}
                onClick={() => action("approve", { confirm: "Батлах уу? Баталсны дараа баримт олгогдож, өөрчлөх боломжгүй болно. · Approve? The credential is then issued immutably." })}>
                Батлах · Approve
              </button>
            )}
            <button className="btn-secondary" disabled={busy}
              onClick={() => action("return", { reasonPrompt: "Буцаах шалтгаан (операторт очно) · Reason for returning:" })}>
              Засварт буцаах · Return
            </button>
            <button className="btn-danger" disabled={busy}
              onClick={() => action("reject", { reasonPrompt: "Татгалзах шалтгаан · Reason for rejection:" })}>
              Татгалзах · Reject
            </button>
          </>
        )}
        {isApprover && c.lifecycleStatus === "APPROVED" && (
          <button className="btn-primary" style={{ marginTop: 0 }} disabled={busy}
            onClick={() => action("issue")}>
            Олголтыг дахин оролдох · Retry issuance
          </button>
        )}
        {isOperator && (c.lifecycleStatus === "DRAFT" || c.lifecycleStatus === "RETURNED") && (
          <button className="btn-secondary" disabled={busy}
            onClick={() => action("cancel", { confirm: "Энэ ноорогийг цуцлах уу? · Cancel this draft?" })}>
            Ноорог цуцлах · Cancel draft
          </button>
        )}
        {c.pdfObjectKey && (
          <a className="btn-secondary" href={`${API_URL}/api/v1/credentials/${c.id}/pdf`}>
            PDF татах · Download PDF
          </a>
        )}
      </div>

      <section className="card" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Эзэмшигч ба мэдээлэл</h2>
        <dl className="claims-list">
          {c.holder && (
            <>
              <dt>Эзэмшигч · Holder</dt>
              <dd>
                {c.holder.lastName} {c.holder.firstName}{" "}
                <span className="mono muted">{c.holder.registrationNumber}</span>
              </dd>
            </>
          )}
          {c.certificateId && (
            <>
              <dt>Сертификатын дугаар</dt>
              <dd className="mono">{c.certificateId}</dd>
            </>
          )}
          {c.credentialNumber && (
            <>
              <dt>Баримтын дугаар · №</dt>
              <dd className="mono">{c.credentialNumber}</dd>
            </>
          )}
          {Object.entries(
            (c.submittedSnapshot ?? c.claims) as Record<string, unknown>,
          ).map(([k, v]) => (
            <FragmentRow key={k} label={k} value={String(v)} />
          ))}
          {c.contentHash && (
            <>
              <dt>Агуулгын хэш ({c.contentHashAlg})</dt>
              <dd className="mono" style={{ wordBreak: "break-all", fontWeight: 400 }}>
                {c.contentHash}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="card">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Түүх · History</h2>
        {data.events.map((e, i) => (
          <div className="check-row" key={i}>
            <span className="muted" style={{ whiteSpace: "nowrap" }}>
              {new Date(e.createdAt).toLocaleString("mn-MN")}
            </span>
            <span>
              <strong>{e.eventType}</strong>
              {e.fromStatus && e.toStatus ? ` — ${e.fromStatus} → ${e.toStatus}` : ""}
              {e.reason ? <div className="muted">{e.reason}</div> : null}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  const labels: Record<string, string> = {
    program: "Хөтөлбөр · Program",
    degree: "Зэрэг · Degree",
    awardedDate: "Төгссөн огноо · Awarded",
  };
  return (
    <>
      <dt>{labels[label] ?? label}</dt>
      <dd>{value}</dd>
    </>
  );
}
