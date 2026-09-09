"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

/**
 * PUB "Төлөв байдал" — public system status (Figma Status Page). Honest,
 * client-observed checks only: outages are reported as unavailability,
 * never conflated with credential validity.
 */

type CheckState = "ok" | "degraded" | "down" | "checking";

interface ServiceCheck {
  key: string;
  title: string;
  description: string;
  state: CheckState;
  detail?: string;
}

const INITIAL: ServiceCheck[] = [
  {
    key: "web",
    title: "Вэб үйлчилгээ",
    description: "Нүүр, баталгаажуулалт, эзэмшигчийн хэсэг",
    state: "ok",
    detail: "Энэ хуудас ачаалагдсан тул ажиллаж байна",
  },
  {
    key: "api",
    title: "Баталгаажуулалтын API",
    description: "Сертификатын дугаар болон VC шалгалт",
    state: "checking",
  },
  {
    key: "statuslist",
    title: "Статус жагсаалт",
    description: "Цуцлалтын нээлттэй жагсаалт (Bitstring Status List)",
    state: "checking",
  },
  {
    key: "anchor",
    title: "Нийтийн нотолгооны сүлжээ",
    description: "Ethereum сүлжээний уншилт (нотолгоо шалгахад)",
    state: "checking",
  },
];

const STATE_UI: Record<CheckState, { label: string; badge: string }> = {
  ok: { label: "Хэвийн", badge: "badge-success" },
  degraded: { label: "Хязгаарлагдмал", badge: "badge-warning" },
  down: { label: "Тасалдсан", badge: "badge-error" },
  checking: { label: "Шалгаж байна…", badge: "badge-info" },
};

const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export default function SystemStatusPage() {
  const [checks, setChecks] = useState<ServiceCheck[]>(INITIAL);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [running, setRunning] = useState(false);

  function update(key: string, state: CheckState, detail?: string) {
    setChecks((prev) =>
      prev.map((c) => (c.key === key ? { ...c, state, ...(detail ? { detail } : {}) } : c)),
    );
  }

  async function runChecks() {
    setRunning(true);
    setChecks((prev) =>
      prev.map((c) => (c.key === "web" ? c : { ...c, state: "checking" as const })),
    );

    await Promise.allSettled([
      fetch(`${API_URL}/api/v1/health`, { signal: AbortSignal.timeout(8000) })
        .then((r) =>
          update("api", r.ok ? "ok" : "degraded", r.ok ? "Хариу хэвийн" : `HTTP ${r.status}`),
        )
        .catch(() => update("api", "down", "Холбогдож чадсангүй")),

      fetch(`${API_URL}/status/1`, { signal: AbortSignal.timeout(8000) })
        .then(async (r) => {
          if (!r.ok) {
            update("statuslist", r.status === 404 ? "degraded" : "down",
              r.status === 404 ? "Жагсаалт хараахан нийтлэгдээгүй" : `HTTP ${r.status}`);
            return;
          }
          const body = (await r.json()) as { validFrom?: string };
          update("statuslist", "ok",
            body.validFrom
              ? `Сүүлд шинэчлэгдсэн: ${new Date(body.validFrom).toLocaleString("mn-MN")}`
              : "Хэвийн");
        })
        .catch(() => update("statuslist", "down", "Холбогдож чадсангүй")),

      fetch(SEPOLIA_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(8000),
      })
        .then(async (r) => {
          const body = (await r.json()) as { result?: string };
          update("anchor", body.result ? "ok" : "degraded",
            body.result ? `Блок #${parseInt(body.result, 16).toLocaleString()}` : "Хариу дутуу");
        })
        .catch(() => update("anchor", "degraded", "Таны сүлжээнээс хандах боломжгүй байж болзошгүй")),
    ]);

    setCheckedAt(new Date());
    setRunning(false);
  }

  useEffect(() => {
    void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allOk = checks.every((c) => c.state === "ok");
  const anyDown = checks.some((c) => c.state === "down");

  return (
    <>
      <h1>Төлөв байдал</h1>
      <p className="subtitle">
        diplom.mn систем болон гол үйлчилгээнүүдийн одоогийн төлөв. Тасалдал нь
        баримтын хүчинтэй байдалд нөлөөлөхгүй — олгогдсон баримт нотолгоотойгоо
        хэвээр үлдэнэ.
      </p>

      <div
        className={`alert ${anyDown ? "alert-error" : allOk ? "alert-success" : "alert-info"}`}
        role="status"
      >
        {anyDown
          ? "Зарим үйлчилгээнд тасалдал ажиглагдаж байна."
          : allOk
            ? "Бүх систем хэвийн ажиллаж байна."
            : "Шалгалт хийгдэж байна…"}
        {checkedAt && (
          <span className="muted" style={{ marginLeft: 8 }}>
            Сүүлийн шалгалт: {checkedAt.toLocaleString("mn-MN")}
          </span>
        )}
      </div>

      {checks.map((c) => (
        <section className="card" key={c.key} style={{ marginBottom: 12, padding: 16 }}>
          <div className="btn-row" style={{ marginTop: 0, alignItems: "center" }}>
            <strong>{c.title}</strong>
            <span className={`badge ${STATE_UI[c.state].badge}`}>
              {STATE_UI[c.state].label}
            </span>
            <span className="muted" style={{ marginLeft: "auto" }}>
              {c.detail}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            {c.description}
          </p>
        </section>
      ))}

      <div className="btn-row">
        <button className="btn-secondary" disabled={running} onClick={runChecks}>
          ↻ Дахин шалгах · Refresh
        </button>
      </div>

      <p className="privacy-note">
        Эдгээр шалгалт таны хөтчөөс шууд хийгдэж байгаа тул таны сүлжээний
        нөхцөлөөс хамаарч болно. Тасалдлын үед аль хэдийн олгогдсон баримтын
        баталгаажуулалт нээлттэй нотолгоогоор боломжтой хэвээр байна.
      </p>
    </>
  );
}
