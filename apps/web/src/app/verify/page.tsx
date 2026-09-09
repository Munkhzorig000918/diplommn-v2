"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_URL } from "../../lib/api";
import {
  TechnicalPanel,
  VcChecksPanel,
  type TechnicalInfo,
  type VcChecks,
} from "./components";

/**
 * VER-001/002 — public verification entry (Astra design): choose a method
 * (QR / share link / certificate ID / VC file / VC paste), then verify.
 * Certificate IDs route to the server-rendered result page; VC bundles are
 * verified via POST /api/v1/verify/bundle with a staged progress view.
 */

type Method = "qr" | "link" | "id" | "vc-file" | "vc-paste";

const METHODS: { key: Method; icon: string; title: string; hint: string }[] = [
  { key: "qr", icon: "▣", title: "QR код унших", hint: "Камер ашиглан QR код уншуулна" },
  { key: "link", icon: "⧉", title: "Холбоос нээх", hint: "Илгээсэн QR эсвэл хуваалцах холбоосыг нээнэ" },
  { key: "id", icon: "№", title: "Гэрчилгээний ID", hint: "Гэрчилгээний ID дугаараар баталгаажуулна" },
  { key: "vc-file", icon: "⇪", title: "VC файл оруулах", hint: "Verifiable Credential (VC) файл оруулна" },
  { key: "vc-paste", icon: "≡", title: "VC хуулж оруулах", hint: "VC JSON-LD агуулгыг хуулж буулгана" },
];

const VC_STEPS = [
  "Мэдээлэл унших",
  "Гарын үсэг шалгах",
  "Төлөв шалгах",
  "Нийтийн нотолгоо",
  "Үр дүн гаргах",
];

interface BundleVerifyResponse {
  result: "VALID" | "REVOKED" | "NOT_VALID" | "INDETERMINATE";
  checks: VcChecks;
  details: string[];
  verifiedAt: string;
  credential: {
    id: string | null;
    type: string[];
    issuer: string;
    validFrom: string | null;
    subject: Record<string, unknown> | null;
  };
  technical: TechnicalInfo;
}

const VC_RESULT_UI = {
  VALID: {
    className: "result-valid",
    icon: "✓",
    title: "Баталгаажсан · Valid",
    meaning:
      "Гарын үсэг хүчинтэй, цуцлагдаагүй байна. · The signature is valid and the credential is not revoked.",
  },
  REVOKED: {
    className: "result-revoked",
    icon: "⨯",
    title: "Цуцлагдсан · Revoked",
    meaning:
      "Энэ баримт олгогдсон боловч хүчингүй болгогдсон байна. · This credential has been revoked.",
  },
  NOT_VALID: {
    className: "result-revoked",
    icon: "⨯",
    title: "Хүчингүй · Not valid",
    meaning:
      "Гарын үсэг эсвэл нотолгоо тохирохгүй байна — баримт өөрчлөгдсөн байж болзошгүй. · A signature or proof check failed — the document may have been altered.",
  },
  INDETERMINATE: {
    className: "result-indeterminate",
    icon: "…",
    title: "Тодорхойлох боломжгүй · Unable to verify",
    meaning:
      "Шаардлагатай шалгалтыг бүрэн гүйцэтгэж чадсангүй. Энэ нь баримтыг хүчингүй гэсэн үг БИШ. · We could not complete all checks. This does NOT mean the credential is invalid.",
  },
} as const;

export default function VerifyInputPage() {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("id");
  const [idValue, setIdValue] = useState("");
  const [linkValue, setLinkValue] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"input" | "checking" | "result">("input");
  const [stepIndex, setStepIndex] = useState(0);
  const [vcResult, setVcResult] = useState<BundleVerifyResponse | null>(null);

  function reset() {
    setPhase("input");
    setVcResult(null);
    setError(null);
    setStepIndex(0);
  }

  function submitId(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = idValue.toUpperCase().replace(/[\s\-_.]/g, "");
    if (cleaned.length !== 20) {
      setError(
        "Сертификатын дугаар 20 тэмдэгтээс бүрдэнэ (жишээ: XXXXX-XXXXX-XXXXX-XXXXX).",
      );
      return;
    }
    router.push(`/verify/${encodeURIComponent(cleaned)}`);
  }

  function submitLink(e: React.FormEvent) {
    e.preventDefault();
    try {
      const url = new URL(linkValue.trim());
      const share = /^\/s\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (share) {
        router.push(`/s/${share[1]}`);
        return;
      }
      const verify = /^\/verify\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (verify) {
        router.push(`/verify/${verify[1]}`);
        return;
      }
      setError(
        "Энэ холбоос diplom.mn-ий хуваалцах эсвэл баталгаажуулах холбоос биш байна.",
      );
    } catch {
      setError("Холбоос буруу байна — бүтэн URL хуулж оруулна уу.");
    }
  }

  async function verifyVcText(text: string) {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("JSON уншигдсангүй — VC файлын агуулгыг бүтнээр нь оруулна уу.");
      return;
    }
    setPhase("checking");
    setStepIndex(0);
    const stepTimer = setInterval(
      () => setStepIndex((i) => Math.min(i + 1, VC_STEPS.length - 1)),
      450,
    );
    try {
      const res = await fetch(`${API_URL}/api/v1/verify/bundle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "Шалгалт амжилтгүй боллоо");
      }
      const report = (await res.json()) as BundleVerifyResponse;
      setStepIndex(VC_STEPS.length - 1);
      setVcResult(report);
      setPhase("result");
    } catch (err) {
      setPhase("input");
      setError(err instanceof Error ? err.message : "Шалгалт амжилтгүй боллоо");
    } finally {
      clearInterval(stepTimer);
    }
  }

  async function onFileChosen(file: File | undefined) {
    if (!file) return;
    await verifyVcText(await file.text());
  }

  if (phase === "checking") {
    return (
      <>
        <h1>Баталгаажуулалтын явц</h1>
        <p className="subtitle">
          Баримтын үнэн зөв, хүчинтэй эсэхийг шалгаж байна. Та түр хүлээнэ үү.
        </p>
        <section className="card">
          <ol className="progress-steps">
            {VC_STEPS.map((label, i) => (
              <li
                key={label}
                className={
                  i < stepIndex ? "step-done" : i === stepIndex ? "step-active" : ""
                }
              >
                <span className="step-dot" aria-hidden />
                {label}
              </li>
            ))}
          </ol>
        </section>
      </>
    );
  }

  if (phase === "result" && vcResult) {
    const ui = VC_RESULT_UI[vcResult.result];
    return (
      <>
        <section className={`result-panel ${ui.className}`} role="status">
          <div className="result-title">
            <span aria-hidden>{ui.icon}</span>
            {ui.title}
          </div>
          <p className="result-meaning">{ui.meaning}</p>
          <p className="result-meta">
            Шалгасан огноо · Verified at:{" "}
            {new Date(vcResult.verifiedAt).toLocaleString("mn-MN")}
          </p>
        </section>

        {vcResult.credential.subject && (
          <section className="card" aria-label="Баримтын мэдээлэл">
            <dl className="claims-list">
              <SubjectRows subject={vcResult.credential.subject} />
              <dt>Олгогч · Issuer</dt>
              <dd className="mono">{vcResult.credential.issuer}</dd>
            </dl>
          </section>
        )}

        <VcChecksPanel checks={vcResult.checks} details={vcResult.details} />
        <TechnicalPanel technical={vcResult.technical} />

        <p style={{ marginTop: "var(--space-6)" }}>
          <a
            href="/verify"
            onClick={(e) => {
              e.preventDefault();
              reset();
            }}
          >
            ← Өөр баримт баталгаажуулах · Verify another credential
          </a>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Баталгаажуулах</h1>
      <p className="subtitle">
        Диплом, гэрчилгээний үнэн зөв, хүчинтэй эсэхийг хурдан бөгөөд найдвартай
        шалгана уу. Нэвтрэх шаардлагагүй. · Verify a diploma or certificate — no
        login required.
      </p>

      <div className="method-grid" role="tablist" aria-label="Баталгаажуулах арга">
        {METHODS.map((m) => (
          <button
            key={m.key}
            role="tab"
            aria-selected={method === m.key}
            className={`method-card${method === m.key ? " method-selected" : ""}`}
            onClick={() => {
              setMethod(m.key);
              setError(null);
            }}
            type="button"
          >
            <span className="method-icon" aria-hidden>
              {m.icon}
            </span>
            <span className="method-title">{m.title}</span>
            <span className="method-hint">{m.hint}</span>
          </button>
        ))}
      </div>

      {method === "id" && (
        <form className="card" onSubmit={submitId}>
          <label className="field-label" htmlFor="certificateId">
            Сертификатын дугаар · Certificate ID
          </label>
          <input
            id="certificateId"
            className="cert-input"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            autoComplete="off"
            autoFocus
            value={idValue}
            onChange={(e) => {
              setIdValue(e.target.value);
              setError(null);
            }}
          />
          <FieldFeedback error={error}>
            Зураас, жижиг үсэг ялгаагүй — байгаагаар нь бичиж болно.
          </FieldFeedback>
          <button className="btn-primary" type="submit">
            Баталгаажуулах · Verify
          </button>
        </form>
      )}

      {method === "link" && (
        <form className="card" onSubmit={submitLink}>
          <label className="field-label" htmlFor="shareLink">
            Хуваалцах холбоос · Share link
          </label>
          <input
            id="shareLink"
            className="cert-input"
            style={{ textTransform: "none", letterSpacing: "normal" }}
            placeholder="https://diplom.mn/s/…"
            autoComplete="off"
            value={linkValue}
            onChange={(e) => {
              setLinkValue(e.target.value);
              setError(null);
            }}
          />
          <FieldFeedback error={error}>
            Танд илгээсэн хуваалцах холбоосыг бүтнээр нь хуулж оруулна уу.
          </FieldFeedback>
          <button className="btn-primary" type="submit">
            Нээх · Open
          </button>
        </form>
      )}

      {method === "vc-file" && (
        <div className="card">
          <label className="field-label" htmlFor="vcFile">
            VC файл · Verifiable Credential (JSON)
          </label>
          <input
            id="vcFile"
            type="file"
            accept=".json,application/json"
            className="file-input"
            onChange={(e) => onFileChosen(e.target.files?.[0])}
          />
          <FieldFeedback error={error}>
            Эзэмшигчийн татаж авсан VC (JSON-LD) эсвэл нотолгооны багц файлыг
            оруулна. Файл таны төхөөрөмж дээрээ уншигдана.
          </FieldFeedback>
        </div>
      )}

      {method === "vc-paste" && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyVcText(pasteValue);
          }}
        >
          <label className="field-label" htmlFor="vcPaste">
            VC агуулга · VC JSON-LD
          </label>
          <textarea
            id="vcPaste"
            className="vc-textarea mono"
            rows={10}
            placeholder='{"@context":["https://www.w3.org/ns/credentials/v2"], …}'
            value={pasteValue}
            onChange={(e) => {
              setPasteValue(e.target.value);
              setError(null);
            }}
          />
          <FieldFeedback error={error}>
            VC файлын агуулгыг бүтнээр нь хуулж буулгана уу.
          </FieldFeedback>
          <button className="btn-primary" type="submit">
            Баталгаажуулах · Verify
          </button>
        </form>
      )}

      {method === "qr" && <QrScanPanel onDetected={(text) => setLinkValue(text)} router={router} setError={setError} error={error} />}

      <p className="privacy-note">
        Баталгаажуулалтын үр дүнд хувь хүний нууцад хамаарах мэдээлэл
        харагдахгүй. · Verification results never expose private personal data.
      </p>
    </>
  );
}

function FieldFeedback({
  error,
  children,
}: {
  error: string | null;
  children: React.ReactNode;
}) {
  return error ? (
    <p className="field-hint" role="alert" style={{ color: "var(--color-error)" }}>
      {error}
    </p>
  ) : (
    <p className="field-hint">{children}</p>
  );
}

function SubjectRows({ subject }: { subject: Record<string, unknown> }) {
  const rows: { label: string; value: string }[] = [];
  const holder = subject.holder as { lastName?: string; firstName?: string } | undefined;
  if (holder?.firstName) {
    rows.push({
      label: "Эзэмшигч · Holder",
      value: `${holder.lastName ?? ""} ${holder.firstName}`.trim(),
    });
  }
  if (typeof subject.diplomaNumber === "string") {
    rows.push({ label: "Дипломын дугаар · Diploma №", value: subject.diplomaNumber });
  }
  const inst = subject.institution as { nameMn?: string } | undefined;
  if (inst?.nameMn) rows.push({ label: "Байгууллага · Institution", value: inst.nameMn });
  const school = subject.school as { name?: string } | undefined;
  if (school?.name) rows.push({ label: "Бүрэлдэхүүн сургууль · School", value: school.name });
  if (typeof subject.educationLevel === "string") {
    rows.push({ label: "Боловсролын зэрэг · Level", value: subject.educationLevel });
  }
  const field = subject.educationField as { code?: string; name?: string } | undefined;
  if (field?.name) {
    rows.push({
      label: "Мэргэжил · Field",
      value: field.code ? `${field.name} (${field.code})` : field.name,
    });
  }
  if (typeof subject.programName === "string") {
    rows.push({ label: "Хөтөлбөр · Program", value: subject.programName });
  }
  if (typeof subject.graduationYear === "string" && subject.graduationYear) {
    rows.push({ label: "Төгссөн он · Graduated", value: subject.graduationYear });
  }
  return (
    <>
      {rows.map((r) => (
        <FragmentRow key={r.label} label={r.label} value={r.value} />
      ))}
    </>
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

/**
 * QR scanning via the native BarcodeDetector API (camera never leaves the
 * device). Falls back to a hint when unsupported.
 */
function QrScanPanel({
  onDetected,
  router,
  setError,
  error,
}: {
  onDetected: (text: string) => void;
  router: { push: (path: string) => void };
  setError: (e: string | null) => void;
  error: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    setSupported("BarcodeDetector" in globalThis);
  }, []);

  useEffect(() => {
    if (!active || !videoRef.current) return;
    let stream: MediaStream | null = null;
    let stop = false;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        const Detector = (
          globalThis as unknown as {
            BarcodeDetector: new (opts: { formats: string[] }) => {
              detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;
        const detector = new Detector({ formats: ["qr_code"] });
        while (!stop) {
          const codes = await detector.detect(video).catch(() => []);
          const raw = codes[0]?.rawValue;
          if (raw) {
            onDetected(raw);
            try {
              const url = new URL(raw);
              const share = /^\/s\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
              if (share) return router.push(`/s/${share[1]}`);
              const verify = /^\/verify\/([A-Za-z0-9]+)$/.exec(url.pathname);
              if (verify) return router.push(`/verify/${verify[1]}`);
            } catch {
              const cleaned = raw.toUpperCase().replace(/[\s\-_.]/g, "");
              if (cleaned.length === 20)
                return router.push(`/verify/${cleaned}`);
            }
            setError("QR кодоос танигдсан утга баталгаажуулах холбоос биш байна.");
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setError("Камерт хандах боломжгүй байна — зөвшөөрөл олгосон эсэхээ шалгана уу.");
        setActive(false);
      }
    }
    void run();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active, onDetected, router, setError]);

  return (
    <div className="card">
      <label className="field-label">QR код унших · Scan QR code</label>
      {supported === false && (
        <p className="field-hint">
          Таны хөтөч камераар QR унших боломжгүй байна — «Холбоос нээх» аргыг
          ашиглана уу. · Your browser does not support camera QR scanning.
        </p>
      )}
      {supported && !active && (
        <>
          <p className="field-hint">
            Камер зөвхөн таны төхөөрөмж дээр ажиллана — зураг сервер лүү
            илгээгдэхгүй.
          </p>
          <button className="btn-primary" type="button" onClick={() => setActive(true)}>
            Камер идэвхжүүлэх · Enable camera
          </button>
        </>
      )}
      {active && (
        <div className="qr-frame">
          <video ref={videoRef} muted playsInline />
          <p className="field-hint">QR кодыг камерын өмнө барина уу…</p>
        </div>
      )}
      {error && (
        <p className="field-hint" role="alert" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
