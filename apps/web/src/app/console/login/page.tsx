"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/** Staff login: password + TOTP (MFA required once enrolled). */
export default function ConsoleLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(totpCode ? { totpCode: totpCode.trim() } : {}),
        }),
      });
      router.replace("/console");
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.details as { totpRequired?: boolean } | undefined)?.totpRequired
      ) {
        setTotpRequired(true);
        setError(null);
      } else {
        setError("Нэвтрэх мэдээлэл буруу байна. · Invalid credentials.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Ажилтны консол</h1>
      <p className="subtitle">
        Олголтын үйл ажиллагааны консол — зөвхөн эрх бүхий ажилтнууд. ·
        Issuance operations console — authorized staff only.
      </p>
      <form className="card form-grid" onSubmit={onSubmit}>
        <div>
          <label htmlFor="email">Имэйл · Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="password">Нууц үг · Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {totpRequired && (
          <div>
            <label htmlFor="totp">Баталгаажуулах код (TOTP) · Authenticator code</label>
            <input
              id="totp"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              autoFocus
            />
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        <div>
          <button className="btn-primary" type="submit" disabled={busy} style={{ marginTop: 0 }}>
            Нэвтрэх · Log in
          </button>
        </div>
      </form>
    </>
  );
}
