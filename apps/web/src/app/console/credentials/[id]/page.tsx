"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  API_URL,
  ApiError,
  CASE_TYPE_LABELS,
  SOURCE_VALIDATION_BADGE,
  SOURCE_VALIDATION_LABELS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
} from "@/lib/api";
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
  sourceValidation: {
    status: string | null;
    checkedAt: string;
    outcome?: string;
    endpoint?: string;
    degreeNumber?: string;
    record?: Record<string, unknown>;
    match?: {
      matched: boolean;
      keysChecked: string[];
      diffs: { key: string; submitted: string; hemis: string }[];
    };
    error?: string;
  } | null;
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

  async function validateSource() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ status: string; outcome: string }>(
        `/api/v1/credentials/${id}/validate-source`,
        { method: "POST" },
      );
      setNotice(
        `HEMIS шалгалт: ${SOURCE_VALIDATION_LABELS[res.status] ?? res.status}`,
      );
      reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "HEMIS шалгалт амжилтгүй боллоо",
      );
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="muted">Ачаалж байна… · Loading…</p>;
  const c = data.credential;
  const isOperator = staffHasRole(staff, "operator");
  const isApprover = staffHasRole(staff, "approver");
  const isLifecycleAdmin = staffHasRole(staff, "lifecycle_admin");
  const isOwnSubmission = c.submittedBy !== null && c.submittedBy === staff?.id;
  const preIssuance = ["DRAFT", "PENDING_APPROVAL", "RETURNED"].includes(
    c.lifecycleStatus,
  );

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
        {isOperator && preIssuance && (
          <button className="btn-secondary" disabled={busy} onClick={validateSource}>
            HEMIS шалгах · Validate against HEMIS
          </button>
        )}
        {c.pdfObjectKey && (
          <a className="btn-secondary" href={`${API_URL}/api/v1/credentials/${c.id}/pdf`}>
            PDF татах · Download PDF
          </a>
        )}
      </div>

      <HemisEvidencePanel
        status={c.sourceValidationStatus}
        evidence={data.sourceValidation}
      />

      {isLifecycleAdmin && c.lifecycleStatus === "ISSUED" && (
        <LifecycleCaseForm credentialId={c.id} />
      )}

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

const HEMIS_FIELD_LABELS: Record<string, string> = {
  degreeNumber: "Дипломын дугаар",
  primaryIdentifierNumber: "Регистрийн дугаар",
  firstName: "Нэр",
  lastName: "Овог",
  institutionName: "Байгууллага",
  educationLevelName: "Боловсролын зэрэг",
  educationFieldCode: "Мэргэжлийн код",
  educationFieldName: "Мэргэжил",
  totalGpa: "Голч дүн",
  conferYearName: "Төгссөн хичээлийн жил",
};

/** APR evidence panel — HEMIS match result with per-field diffs. */
function HemisEvidencePanel({
  status,
  evidence,
}: {
  status: string;
  evidence: Detail["sourceValidation"];
}) {
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>
        HEMIS баталгаажуулалт{" "}
        <span className={`badge ${SOURCE_VALIDATION_BADGE[status] ?? "badge-neutral"}`}>
          {SOURCE_VALIDATION_LABELS[status] ?? status}
        </span>
      </h2>
      {!evidence ? (
        <p className="muted">
          HEMIS-тэй тулгаагүй байна. Илгээхийн өмнө «HEMIS шалгах» товчоор
          шалгана уу. · Not yet validated against HEMIS.
        </p>
      ) : (
        <>
          <p className="muted">
            Шалгасан: {new Date(evidence.checkedAt).toLocaleString("mn-MN")}
            {evidence.endpoint ? ` · endpoint: ${evidence.endpoint}` : ""}
            {evidence.degreeNumber ? ` · дугаар: ${evidence.degreeNumber}` : ""}
          </p>
          {evidence.error && (
            <div className="alert alert-error">{evidence.error}</div>
          )}
          {evidence.match && evidence.match.diffs.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Талбар</th>
                    <th>Мэдүүлсэн утга</th>
                    <th>HEMIS утга</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.match.diffs.map((d) => (
                    <tr key={d.key}>
                      <td>{HEMIS_FIELD_LABELS[d.key] ?? d.key}</td>
                      <td className="mono">{d.submitted || "—"}</td>
                      <td className="mono">{d.hemis || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {evidence.record && (
            <dl className="claims-list" style={{ marginTop: 12 }}>
              {Object.entries(evidence.record)
                .filter(([, v]) => v !== null && v !== "")
                .map(([k, v]) => (
                  <FragmentRow
                    key={k}
                    label={HEMIS_FIELD_LABELS[k] ?? k}
                    value={String(v)}
                  />
                ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

const REASON_CODES: { value: string; label: string }[] = [
  { value: "DATA_ERROR", label: "Мэдээллийн алдаа · Data error" },
  { value: "FRAUD", label: "Хуурамч бүрдүүлэлт · Fraud" },
  { value: "INSTITUTION_REQUEST", label: "Байгууллагын хүсэлт · Institution request" },
  { value: "HOLDER_REQUEST", label: "Эзэмшигчийн хүсэлт · Holder request" },
  { value: "OTHER", label: "Бусад · Other" },
];

/** LIFE-001 — open a revoke/correct/reissue case (dual control decides it). */
function LifecycleCaseForm({ credentialId }: { credentialId: string }) {
  const router = useRouter();
  const [caseType, setCaseType] = useState("REVOKE");
  const [reasonCode, setReasonCode] = useState("DATA_ERROR");
  const [reasonDetail, setReasonDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reasonDetail.trim().length < 10) {
      setError("Дэлгэрэнгүй шалтгаанаа 10-аас доошгүй тэмдэгтээр бичнэ үү.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/lifecycle-cases", {
        method: "POST",
        body: JSON.stringify({
          credentialId,
          caseType,
          reasonCode,
          reasonDetail: reasonDetail.trim(),
        }),
      });
      router.push("/console/lifecycle");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Кейс үүсгэж чадсангүй",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>
        Lifecycle кейс нээх · Open lifecycle case
      </h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Кейс нээгдмэгц өөр админ шийднэ (хос хяналт). REVOKE батлагдмагц баримт
        цуцлагдана; CORRECT/REISSUE нь солих ноорог үүсгэнэ.
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <form className="form-grid" onSubmit={submit}>
        <div>
          <label htmlFor="caseType">Төрөл · Type</label>
          <select
            id="caseType"
            value={caseType}
            onChange={(e) => setCaseType(e.target.value)}
          >
            {Object.entries(CASE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="reasonCode">Шалтгааны код · Reason code</label>
          <select
            id="reasonCode"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
          >
            {REASON_CODES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="reasonDetail">Дэлгэрэнгүй шалтгаан · Detail</label>
          <textarea
            id="reasonDetail"
            rows={3}
            value={reasonDetail}
            onChange={(e) => setReasonDetail(e.target.value)}
            placeholder="Шийдвэр гаргагчид зориулж нөхцөл байдлыг тодорхой бичнэ…"
          />
        </div>
        <div>
          <button className="btn-danger" type="submit" disabled={busy}>
            Кейс нээх · Open case
          </button>
        </div>
      </form>
    </section>
  );
}
