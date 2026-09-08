"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/**
 * AUTH-001/002 — holder login (MVP: OTP to the contact on file).
 * Responses never reveal whether a registration number exists.
 */
export default function PortalLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"request" | "verify">("request");
  const [regNum, setRegNum] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ challengeId: string; message: string }>(
        "/api/v1/holder/otp/request",
        {
          method: "POST",
          body: JSON.stringify({ registrationNumber: regNum.trim() }),
        },
      );
      setChallengeId(res.challengeId);
      setMessage(res.message);
      setStep("verify");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Хүсэлт амжилтгүй боллоо · Request failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/holder/otp/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId, code: code.trim() }),
      });
      router.replace("/portal");
    } catch {
      setError(
        "Код буруу эсвэл хугацаа нь дууссан байна. · The code is wrong or has expired.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Эзэмшигчийн портал</h1>
      <p className="subtitle">
        Өөрийн диплом, гэрчилгээг харах, татах, хуваалцахын тулд нэвтэрнэ үү. ·
        Log in to view, download and share your credentials.
      </p>

      {step === "request" ? (
        <form className="card" onSubmit={requestOtp}>
          <label className="field-label" htmlFor="regnum">
            Регистрийн дугаар · Registration number
          </label>
          <input
            id="regnum"
            className="cert-input"
            autoComplete="off"
            value={regNum}
            onChange={(e) => setRegNum(e.target.value)}
            required
            minLength={4}
            maxLength={20}
          />
          <p className="field-hint">
            Бүртгэлтэй имэйл хаяг руу нэг удаагийн код илгээгдэнэ. Холбоо
            барих хаяггүй бол сургуулилдаа хандана уу. · A one-time code is
            sent to the contact on file; if none exists, contact your
            institution.
          </p>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn-primary" type="submit" disabled={busy}>
            Код авах · Send code
          </button>
        </form>
      ) : (
        <form className="card" onSubmit={verifyOtp}>
          {message && <div className="alert alert-info">{message}</div>}
          <label className="field-label" htmlFor="otp">
            Нэг удаагийн код · One-time code
          </label>
          <input
            id="otp"
            className="cert-input"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {error && <div className="alert alert-error">{error}</div>}
          <div className="btn-row">
            <button className="btn-primary" type="submit" disabled={busy}>
              Нэвтрэх · Log in
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setStep("request");
                setCode("");
                setError(null);
              }}
            >
              Дахин код авах · Request a new code
            </button>
          </div>
        </form>
      )}
    </>
  );
}
