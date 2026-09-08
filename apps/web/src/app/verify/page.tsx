"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * VER-001 — public verification input (MVP path: Certificate ID).
 * QR scanning and VC upload arrive with M2/V2.
 */
export default function VerifyInputPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = value.toUpperCase().replace(/[\s\-_.]/g, "");
    if (cleaned.length !== 20) {
      setError(
        "Сертификатын дугаар 20 тэмдэгтээс бүрдэнэ (жишээ: XXXXX-XXXXX-XXXXX-XXXXX). / The certificate ID has 20 characters.",
      );
      return;
    }
    router.push(`/verify/${encodeURIComponent(cleaned)}`);
  }

  return (
    <>
      <h1>Баримт баталгаажуулах</h1>
      <p className="subtitle">
        Диплом, гэрчилгээн дээрх сертификатын дугаарыг оруулж үнэн зөвийг нь
        шалгана уу. Нэвтрэх шаардлагагүй. · Enter the certificate ID printed on
        the document to verify it. No login required.
      </p>

      <form className="card" onSubmit={onSubmit}>
        <label className="field-label" htmlFor="certificateId">
          Сертификатын дугаар · Certificate ID
        </label>
        <input
          id="certificateId"
          className="cert-input"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--color-error)" }}>
            {error}
          </p>
        ) : (
          <p className="field-hint">
            Зураас, жижиг үсэг ялгаагүй — байгаагаар нь бичиж болно. · Dashes
            and letter case do not matter.
          </p>
        )}
        <button className="btn-primary" type="submit">
          Баталгаажуулах · Verify
        </button>
      </form>

      <p className="privacy-note">
        Баталгаажуулалтын үр дүнд хувь хүний нууцад хамаарах мэдээлэл
        харагдахгүй. · Verification results never expose private personal data.
      </p>
    </>
  );
}
