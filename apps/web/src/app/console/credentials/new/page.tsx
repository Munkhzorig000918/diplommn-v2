"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface RefItem {
  id: string;
  code: string;
  nameMn: string;
}

/**
 * ISS-001/003 (MVP form) — manual issuance draft. Source-of-truth fields come
 * from the operator in the MVP; HEMIS lookup+attestation replaces free entry
 * in V2 Phase 1 (fields then become read-only with provenance chips).
 */
export default function NewCredentialPage() {
  const router = useRouter();
  const [institutions, setInstitutions] = useState<RefItem[]>([]);
  const [types, setTypes] = useState<RefItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    institutionId: "",
    credentialTypeId: "",
    lastName: "",
    firstName: "",
    registrationNumber: "",
    email: "",
    credentialNumber: "",
    program: "",
    degree: "",
    awardedDate: "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    Promise.all([
      api<{ items: RefItem[] }>("/api/v1/institutions"),
      api<{ items: RefItem[] }>("/api/v1/credential-types"),
    ])
      .then(([inst, t]) => {
        setInstitutions(inst.items);
        setTypes(t.items);
      })
      .catch(() => setError("Лавлах өгөгдөл ачаалагдсангүй · Failed to load reference data"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: string }>("/api/v1/credentials", {
        method: "POST",
        body: JSON.stringify({
          institutionId: form.institutionId,
          credentialTypeId: form.credentialTypeId,
          holder: {
            lastName: form.lastName.trim(),
            firstName: form.firstName.trim(),
            registrationNumber: form.registrationNumber.trim(),
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
          },
          ...(form.credentialNumber.trim()
            ? { credentialNumber: form.credentialNumber.trim() }
            : {}),
          claims: {
            program: form.program.trim(),
            degree: form.degree.trim(),
            awardedDate: form.awardedDate,
          },
        }),
      });
      router.push(`/console/credentials/${res.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Хадгалж чадсангүй · Failed to save",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Шинэ олголт — ноорог</h1>
      <p className="subtitle">
        Ноорог үүсгээд илгээснээр бие даасан зөвшөөрөгчийн хяналтад орно. ·
        Drafts go to an independent approver on submission.
      </p>
      <form className="card form-grid" onSubmit={onSubmit}>
        <div>
          <label htmlFor="inst">Байгууллага · Institution</label>
          <select id="inst" value={form.institutionId} onChange={set("institutionId")} required>
            <option value="">— сонгох · select —</option>
            {institutions.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} — {i.nameMn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="type">Баримтын төрөл · Credential type</label>
          <select id="type" value={form.credentialTypeId} onChange={set("credentialTypeId")} required>
            <option value="">— сонгох · select —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.nameMn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ln">Эцэг/эхийн нэр · Last name</label>
          <input id="ln" value={form.lastName} onChange={set("lastName")} required maxLength={100} />
        </div>
        <div>
          <label htmlFor="fn">Нэр · First name</label>
          <input id="fn" value={form.firstName} onChange={set("firstName")} required maxLength={100} />
        </div>
        <div>
          <label htmlFor="rn">Регистрийн дугаар · Registration number</label>
          <input id="rn" value={form.registrationNumber} onChange={set("registrationNumber")} required minLength={4} maxLength={20} />
        </div>
        <div>
          <label htmlFor="em">Имэйл (порталын нэвтрэлтэд) · Email (for portal login)</label>
          <input id="em" type="email" value={form.email} onChange={set("email")} />
        </div>
        <div>
          <label htmlFor="cn">Дипломын дугаар · Document №</label>
          <input id="cn" value={form.credentialNumber} onChange={set("credentialNumber")} maxLength={100} />
        </div>
        <div>
          <label htmlFor="pr">Хөтөлбөр · Program</label>
          <input id="pr" value={form.program} onChange={set("program")} required maxLength={300} />
        </div>
        <div>
          <label htmlFor="dg">Зэрэг · Degree</label>
          <input id="dg" value={form.degree} onChange={set("degree")} required maxLength={300} />
        </div>
        <div>
          <label htmlFor="ad">Төгссөн огноо · Awarded date</label>
          <input id="ad" type="date" value={form.awardedDate} onChange={set("awardedDate")} required />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div>
          <button className="btn-primary" type="submit" disabled={busy} style={{ marginTop: 0 }}>
            Ноорог хадгалах · Save draft
          </button>
        </div>
      </form>
    </>
  );
}
