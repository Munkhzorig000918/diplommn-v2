"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  CASE_STATUS_BADGE,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
} from "@/lib/api";
import { staffHasRole, useStaff } from "../layout";

/**
 * LIFE-001/002 — lifecycle cases (revoke / correct / reissue). Cases are
 * never immediate row actions: dual control means the requester can never
 * decide their own case, and REVOKE decisions take effect on approval.
 */

interface CaseRow {
  id: string;
  credentialId: string;
  caseType: string;
  status: string;
  reasonCode: string;
  reasonDetail: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  replacementCredentialId: string | null;
  createdAt: string;
}

export default function LifecycleCasesPage() {
  const staff = useStaff();
  const [items, setItems] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ items: CaseRow[] }>("/api/v1/lifecycle-cases")
      .then((res) => {
        setItems(res.items);
        setError(null);
      })
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);

  const canDecide = staffHasRole(staff, "lifecycle_admin", "approver");

  async function decide(row: CaseRow, action: "approve" | "reject") {
    const prompts = {
      approve:
        row.caseType === "REVOKE"
          ? "Батлах уу? Баримт ШУУД ЦУЦЛАГДАНА. · Approve? The credential is revoked immediately."
          : "Батлах уу? Солих ноорог үүснэ. · Approve? A replacement draft is opened.",
      reject: "Татгалзах тэмдэглэл · Rejection note:",
    };
    let body: string | undefined;
    if (action === "reject") {
      const note = window.prompt(prompts.reject);
      if (!note) return;
      body = JSON.stringify({ note });
    } else if (!window.confirm(prompts.approve)) {
      return;
    }
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/v1/lifecycle-cases/${row.id}/${action}`, {
        method: "POST",
        ...(body ? { body } : {}),
      });
      setNotice(
        action === "approve"
          ? "Кейс батлагдлаа · Case approved"
          : "Кейс татгалзагдлаа · Case rejected",
      );
      reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Үйлдэл амжилтгүй · Action failed",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1>Lifecycle кейсүүд</h1>
      <p className="subtitle">
        Цуцлах, засварлах, дахин олгох хүсэлтүүд — хос хяналттай: хүсэлт
        гаргагч өөрийн кейсийг шийдэж чадахгүй.
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="muted">Ачаалж байна… · Loading…</p>
      ) : items.length === 0 ? (
        <div className="card">
          <p className="muted">
            Кейс бүртгэгдээгүй байна. Кейсийг олгогдсон баримтын дэлгэрэнгүй
            хуудаснаас үүсгэнэ. · No cases yet — open one from an issued
            credential&apos;s detail page.
          </p>
        </div>
      ) : (
        items.map((row) => {
          const isOwn = row.requestedBy === staff?.id;
          return (
            <section className="card" key={row.id}>
              <div className="btn-row" style={{ marginTop: 0, alignItems: "center" }}>
                <strong>{CASE_TYPE_LABELS[row.caseType] ?? row.caseType}</strong>
                <span className={`badge ${CASE_STATUS_BADGE[row.status] ?? "badge-neutral"}`}>
                  {CASE_STATUS_LABELS[row.status] ?? row.status}
                </span>
                <span className="muted">
                  {new Date(row.createdAt).toLocaleString("mn-MN")}
                </span>
              </div>
              <dl className="claims-list" style={{ marginTop: 12 }}>
                <dt>Баримт · Credential</dt>
                <dd>
                  <Link href={`/console/credentials/${row.credentialId}`} className="mono">
                    {row.credentialId.slice(0, 8)}…
                  </Link>
                </dd>
                <dt>Шалтгаан · Reason</dt>
                <dd>
                  {row.reasonCode}
                  <div className="muted" style={{ fontWeight: 400 }}>
                    {row.reasonDetail}
                  </div>
                </dd>
                {row.decisionNote && (
                  <>
                    <dt>Шийдвэрийн тэмдэглэл</dt>
                    <dd style={{ fontWeight: 400 }}>{row.decisionNote}</dd>
                  </>
                )}
                {row.replacementCredentialId && (
                  <>
                    <dt>Солих баримт · Replacement</dt>
                    <dd>
                      <Link
                        href={`/console/credentials/${row.replacementCredentialId}`}
                        className="mono"
                      >
                        {row.replacementCredentialId.slice(0, 8)}…
                      </Link>
                    </dd>
                  </>
                )}
              </dl>
              {row.status === "OPEN" && canDecide && (
                <div className="btn-row">
                  {isOwn ? (
                    <span className="alert alert-info" style={{ margin: 0 }}>
                      Өөрийн үүсгэсэн кейсийг шийдэх боломжгүй (хос хяналт). ·
                      Dual control — you cannot decide your own case.
                    </span>
                  ) : (
                    <>
                      <button
                        className="btn-primary"
                        style={{ marginTop: 0 }}
                        disabled={busyId === row.id}
                        onClick={() => decide(row, "approve")}
                      >
                        Батлах · Approve
                      </button>
                      <button
                        className="btn-danger"
                        disabled={busyId === row.id}
                        onClick={() => decide(row, "reject")}
                      >
                        Татгалзах · Reject
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
