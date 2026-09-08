import type { Metadata } from "next";
import Link from "next/link";

/**
 * VER-003 — public verification result. Server-rendered, never indexed
 * (D2V2 §16.4: prevent search engines from indexing result pages).
 * The four MVP outcomes map to honest, non-accusatory language (§16.3):
 * network/API failure is presented as "unable to verify", never as invalid.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Баталгаажуулалтын үр дүн — diplom.mn",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface VerifyResponse {
  result: "VALID" | "REVOKED" | "SUPERSEDED" | "NOT_FOUND";
  verifiedAt: string;
  message?: string;
  credential?: {
    certificateId: string;
    credentialNumber: string | null;
    holderName: string | null;
    institution: { code: string; nameMn: string; nameEn: string };
    credentialType: { kind: string; nameMn: string; nameEn: string };
    issuedAt: string | null;
    publicClaims: Record<string, unknown>;
  };
  checks?: { check: string; status: string; description: string }[];
}

const RESULT_UI = {
  VALID: {
    className: "result-valid",
    icon: "✓",
    titleMn: "Баталгаатай",
    titleEn: "Valid",
    meaning:
      "Энэ баримтыг diplom.mn олгосон бөгөөд одоогоор хүчингүй болгоогүй байна. · Issued via diplom.mn and not currently revoked.",
  },
  REVOKED: {
    className: "result-revoked",
    icon: "⨯",
    titleMn: "Цуцлагдсан",
    titleEn: "Revoked",
    meaning:
      "Энэ баримт олгогдсон боловч хүчингүй болгогдсон тул хүчинтэйд тооцохгүй. · This credential was issued but has been revoked — do not treat it as valid.",
  },
  SUPERSEDED: {
    className: "result-superseded",
    icon: "↻",
    titleMn: "Шинэ хувилбараар солигдсон",
    titleEn: "Superseded",
    meaning:
      "Энэ баримтын оронд шинэчилсэн баримт олгогдсон байна. · A replacement credential has been issued for this document.",
  },
  NOT_FOUND: {
    className: "result-notfound",
    icon: "?",
    titleMn: "Бүртгэл олдсонгүй",
    titleEn: "Not found",
    meaning:
      "Энэ дугаараар баталгаажуулах боломжтой баримт олдсонгүй. Дугаараа шалгаад дахин оролдоно уу. · No verifiable credential was found for this identifier — check the identifier and try again.",
  },
} as const;

const CLAIM_LABELS: Record<string, string> = {
  program: "Хөтөлбөр · Program",
  degree: "Зэрэг · Degree",
  awardedDate: "Төгссөн огноо · Awarded",
};

export default async function VerifyResultPage({
  params,
}: {
  params: Promise<{ certificateId: string }>;
}) {
  const { certificateId } = await params;

  let data: VerifyResponse | null = null;
  let formatError: string | null = null;
  let unavailable = false;

  try {
    const res = await fetch(
      `${API_URL}/api/v1/verify/${encodeURIComponent(certificateId)}`,
      { cache: "no-store" },
    );
    if (res.status === 400) {
      formatError =
        "Сертификатын дугаарын бичиглэл буруу байна. XXXXX-XXXXX-XXXXX-XXXXX хэлбэрээр оруулна уу. · The certificate ID format is invalid.";
    } else if (res.ok) {
      data = (await res.json()) as VerifyResponse;
    } else {
      unavailable = true;
    }
  } catch {
    unavailable = true;
  }

  if (formatError) {
    return (
      <>
        <ResultPanel
          className="result-notfound"
          icon="!"
          title="Буруу бичиглэл · Invalid format"
          meaning={formatError}
        />
        <VerifyAnother />
      </>
    );
  }

  if (unavailable || !data) {
    return (
      <>
        <ResultPanel
          className="result-indeterminate"
          icon="…"
          title="Тодорхойлох боломжгүй · Unable to verify"
          meaning="Шаардлагатай шалгалтыг одоогоор гүйцэтгэх боломжгүй байна. Энэ нь баримтыг хүчингүй гэсэн үг БИШ — түр зуурын саатал байж болзошгүй тул дахин оролдоно уу. · We could not complete the required checks. This does NOT mean the credential is invalid — please retry later."
        />
        <VerifyAnother />
      </>
    );
  }

  const ui = RESULT_UI[data.result];
  const cred = data.credential;

  return (
    <>
      <ResultPanel
        className={ui.className}
        icon={ui.icon}
        title={`${ui.titleMn} · ${ui.titleEn}`}
        meaning={ui.meaning}
        meta={`Шалгасан огноо · Verified at: ${new Date(data.verifiedAt).toLocaleString("mn-MN")}`}
      />

      {cred && (
        <section className="card" aria-label="Баримтын мэдээлэл">
          <dl className="claims-list">
            <dt>Сертификатын дугаар · Certificate ID</dt>
            <dd style={{ fontFamily: "var(--font-mono), monospace" }}>
              {cred.certificateId}
            </dd>
            {cred.holderName && (
              <>
                <dt>Эзэмшигч · Holder</dt>
                <dd>{cred.holderName}</dd>
              </>
            )}
            <dt>Байгууллага · Institution</dt>
            <dd>
              {cred.institution.nameMn}
              <div style={{ fontWeight: 400, color: "var(--color-text-secondary)", fontSize: 14 }}>
                {cred.institution.nameEn}
              </div>
            </dd>
            <dt>Баримтын төрөл · Credential type</dt>
            <dd>{cred.credentialType.nameMn}</dd>
            {cred.credentialNumber && (
              <>
                <dt>Баримтын дугаар · Document №</dt>
                <dd>{cred.credentialNumber}</dd>
              </>
            )}
            {Object.entries(cred.publicClaims).map(([key, value]) => (
              <FragmentRow key={key} label={CLAIM_LABELS[key] ?? key} value={String(value)} />
            ))}
            {cred.issuedAt && (
              <>
                <dt>Олгосон огноо · Issued</dt>
                <dd>{new Date(cred.issuedAt).toLocaleDateString("mn-MN")}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      {data.checks && data.checks.length > 0 && (
        <section className="card" aria-label="Шалгалтууд">
          {data.checks.map((c) => (
            <div className="check-row" key={c.check}>
              <span className={c.status === "PASSED" ? "check-passed" : "check-failed"}>
                {c.status === "PASSED" ? "✓" : "⨯"}
              </span>
              <span>{c.description}</span>
            </div>
          ))}
        </section>
      )}

      <p className="privacy-note">
        Хувийн мэдээлэл нээлттэй сүлжээнд хадгалагдаагүй бөгөөд энэ хуудсанд
        зөвхөн баталгаажуулалтад шаардлагатай доод хэмжээний мэдээлэл харагдана.
        · Personal data is not stored on any public network; this page shows
        only the minimum needed for verification.
      </p>
      <VerifyAnother />
    </>
  );
}

function ResultPanel(props: {
  className: string;
  icon: string;
  title: string;
  meaning: string;
  meta?: string;
}) {
  return (
    <section className={`result-panel ${props.className}`} role="status">
      <div className="result-title">
        <span aria-hidden>{props.icon}</span>
        {props.title}
      </div>
      <p className="result-meaning">{props.meaning}</p>
      {props.meta && <p className="result-meta">{props.meta}</p>}
    </section>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function VerifyAnother() {
  return (
    <p style={{ marginTop: "var(--space-6)" }}>
      <Link href="/verify">← Өөр баримт баталгаажуулах · Verify another credential</Link>
    </p>
  );
}
