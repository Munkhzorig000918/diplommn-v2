"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface HolderMe {
  holder: { firstName: string; lastName: string; registrationNumber: string };
}

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/portal/login";
  const [holder, setHolder] = useState<HolderMe["holder"] | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (isLogin) {
      setChecked(true);
      return;
    }
    api<HolderMe>("/api/v1/holder/me")
      .then((res) => setHolder(res.holder))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          router.replace("/portal/login");
        }
      })
      .finally(() => setChecked(true));
  }, [isLogin, pathname, router]);

  async function logout() {
    try {
      await api("/api/v1/holder/logout", { method: "POST" });
    } finally {
      router.replace("/portal/login");
    }
  }

  if (!checked) return <p className="muted">Ачаалж байна… · Loading…</p>;

  return (
    <>
      {!isLogin && (
        <nav className="subnav" aria-label="Портал цэс">
          <Link href="/portal" className={pathname === "/portal" ? "active" : ""}>
            Миний баримтууд · My credentials
          </Link>
          <Link
            href="/portal/shares"
            className={pathname === "/portal/shares" ? "active" : ""}
          >
            Хуваалцалтууд · Shares
          </Link>
          {holder && (
            <button
              type="button"
              className="btn-secondary"
              onClick={logout}
              style={{ marginLeft: "auto" }}
            >
              Гарах · Log out ({holder.firstName})
            </button>
          )}
        </nav>
      )}
      {children}
    </>
  );
}
