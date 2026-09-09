"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { staffHasRole, useStaff } from "../layout";

/**
 * ADM-001 — staff accounts and role grants. Invitation-based onboarding:
 * admins never set passwords; the invite token is delivered out-of-band
 * (shown once here until email delivery is wired).
 */

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  status: string;
  createdAt: string;
  roles: { role: string; institutionId: string | null }[];
}

const ROLE_LABELS: Record<string, string> = {
  platform_admin: "Платформ админ",
  operator: "Оператор",
  approver: "Зөвшөөрөгч",
  lifecycle_admin: "Lifecycle админ",
  auditor: "Аудитор",
};

const USER_STATUS_LABELS: Record<string, string> = {
  INVITED: "Урьсан · Invited",
  ACTIVE: "Идэвхтэй · Active",
  SUSPENDED: "Түдгэлзүүлсэн · Suspended",
  LOCKED: "Түгжигдсэн · Locked",
  INVITATION_EXPIRED: "Урилга хүчингүй · Invite expired",
  DEACTIVATED: "Идэвхгүй · Deactivated",
};

const USER_STATUS_BADGE: Record<string, string> = {
  INVITED: "badge-info",
  ACTIVE: "badge-success",
  SUSPENDED: "badge-warning",
  LOCKED: "badge-warning",
  INVITATION_EXPIRED: "badge-neutral",
  DEACTIVATED: "badge-neutral",
};

export default function UsersAdminPage() {
  const staff = useStaff();
  const [items, setItems] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    api<{ users: UserRow[] }>("/api/v1/users")
      .then((res) => {
        setItems(res.users);
        setError(null);
      })
      .catch(() => setError("Жагсаалтыг ачаалж чадсангүй · Failed to load"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);

  return (
    <>
      <h1>Хэрэглэгчид · Staff accounts</h1>
      <p className="subtitle">
        Ажилтны эрх, төлөвийн удирдлага. Админ нууц үг тохируулдаггүй —
        урилгаар өөрөө үүсгэнэ.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      {staffHasRole(staff, "platform_admin") && <InviteForm onInvited={reload} />}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Имэйл</th>
              <th>Нэр</th>
              <th>Эрхүүд</th>
              <th>Төлөв</th>
              <th>Бүртгэсэн</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="muted">
                  Ачаалж байна… · Loading…
                </td>
              </tr>
            ) : (
              items.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.email}</td>
                  <td>{u.fullName}</td>
                  <td>
                    {u.roles.map((r) => (
                      <span
                        key={`${r.role}-${r.institutionId ?? "g"}`}
                        className="badge badge-info"
                        style={{ marginRight: 4 }}
                      >
                        {ROLE_LABELS[r.role] ?? r.role}
                        {r.institutionId ? " (сургууль)" : ""}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`badge ${USER_STATUS_BADGE[u.status] ?? "badge-neutral"}`}>
                      {USER_STATUS_LABELS[u.status]?.split(" · ")[0] ?? u.status}
                    </span>
                  </td>
                  <td className="muted">
                    {new Date(u.createdAt).toLocaleDateString("mn-MN")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roles, setRoles] = useState<string[]>(["operator"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);

  function toggleRole(role: string) {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (roles.length === 0) {
      setError("Дор хаяж нэг эрх сонгоно уу.");
      return;
    }
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const res = await api<{ token: string; expiresAt: string }>(
        "/api/v1/users/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            email: email.trim(),
            fullName: fullName.trim(),
            roles: roles.map((role) => ({ role, institutionId: null })),
          }),
        },
      );
      setIssued(res);
      setEmail("");
      setFullName("");
      onInvited();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Урилга үүсгэж чадсангүй");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Шинэ ажилтан урих · Invite staff</h2>
      {error && <div className="alert alert-error">{error}</div>}
      {issued && (
        <div className="alert alert-success" style={{ wordBreak: "break-all" }}>
          Урилга үүслээ (7 хоног хүчинтэй). Токеныг найдвартай сувгаар
          дамжуулна уу: <span className="mono">{issued.token}</span>
        </div>
      )}
      <form className="form-grid" onSubmit={submit}>
        <div>
          <label htmlFor="invEmail">Имэйл · Email</label>
          <input
            id="invEmail"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="invName">Бүтэн нэр · Full name</label>
          <input
            id="invName"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
        <div>
          <span className="field-label">Эрхүүд · Roles</span>
          <div className="btn-row" style={{ marginTop: 4 }}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <label key={value} style={{ fontWeight: 400, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={roles.includes(value)}
                  onChange={() => toggleRole(value)}
                  style={{ marginRight: 6 }}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="field-hint">
            Хос хяналт: илгээгч ба батлагч нэг хүн байж болохгүй тул эрхийг
            салгаж олгоно уу. Сургуулийн хязгаарлалттай эрх олгох нь дараагийн
            шатанд.
          </p>
        </div>
        <div>
          <button className="btn-primary" style={{ marginTop: 0 }} disabled={busy} type="submit">
            Урилга илгээх · Send invite
          </button>
        </div>
      </form>
    </section>
  );
}
