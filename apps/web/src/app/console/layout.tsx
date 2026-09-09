"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

export interface StaffUser {
  id: string;
  email: string;
  fullName: string;
  roles: { role: string; institutionId: string | null }[];
}

const StaffContext = createContext<StaffUser | null>(null);
export const useStaff = () => useContext(StaffContext);

export function staffHasRole(user: StaffUser | null, ...roles: string[]): boolean {
  return !!user && user.roles.some((r) => roles.includes(r.role));
}

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/console/login";
  const [user, setUser] = useState<StaffUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (isLogin) {
      setChecked(true);
      return;
    }
    api<{ user: StaffUser }>("/api/v1/auth/me")
      .then((res) => setUser(res.user))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          router.replace("/console/login");
        }
      })
      .finally(() => setChecked(true));
  }, [isLogin, pathname, router]);

  async function logout() {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } finally {
      router.replace("/console/login");
    }
  }

  if (!checked) return <p className="muted">Ачаалж байна… · Loading…</p>;

  return (
    <StaffContext.Provider value={user}>
      {!isLogin && (
        <nav className="subnav" aria-label="Консол цэс">
          <Link href="/console" className={pathname === "/console" ? "active" : ""}>
            Ажлын дараалал · Work queue
          </Link>
          {staffHasRole(user, "operator", "approver", "lifecycle_admin", "platform_admin", "auditor") && (
            <Link
              href="/console/credentials"
              className={pathname === "/console/credentials" ? "active" : ""}
            >
              Баримтууд · Credentials
            </Link>
          )}
          {staffHasRole(user, "operator") && (
            <Link
              href="/console/credentials/new"
              className={pathname === "/console/credentials/new" ? "active" : ""}
            >
              Шинэ олголт · New issuance
            </Link>
          )}
          {staffHasRole(user, "lifecycle_admin", "approver") && (
            <Link
              href="/console/lifecycle"
              className={pathname.startsWith("/console/lifecycle") ? "active" : ""}
            >
              Lifecycle кейс
            </Link>
          )}
          {staffHasRole(user, "operator", "approver", "platform_admin") && (
            <Link
              href="/console/imports"
              className={pathname.startsWith("/console/imports") ? "active" : ""}
            >
              Импорт · Imports
            </Link>
          )}
          {staffHasRole(user, "platform_admin", "auditor") && (
            <Link
              href="/console/ops"
              className={pathname === "/console/ops" ? "active" : ""}
            >
              Систем · Ops
            </Link>
          )}
          {user && (
            <button
              type="button"
              className="btn-secondary"
              onClick={logout}
              style={{ marginLeft: "auto" }}
            >
              Гарах · Log out ({user.fullName})
            </button>
          )}
        </nav>
      )}
      {children}
    </StaffContext.Provider>
  );
}
