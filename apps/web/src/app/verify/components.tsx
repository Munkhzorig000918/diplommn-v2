/**
 * Shared verification UI pieces (Astra VER screens): check rows and the
 * "Техникийн баталгаа" panel. Presentational only — usable from both the
 * server-rendered certificate result page and the client VC-verify flow.
 */

export type CheckOutcome = "PASS" | "FAIL" | "UNAVAILABLE" | "PENDING" | "SKIPPED";

export interface VcChecks {
  signature: CheckOutcome;
  revocation: CheckOutcome;
  anchor: CheckOutcome;
}

export interface TechnicalAnchor {
  batchId: string;
  merkleRoot: string;
  chainId: number;
  contractAddress: string;
  txHash: string | null;
  blockNumber: string | null;
  status: string;
}

export interface TechnicalInfo {
  issuerDid?: string | null;
  verificationMethod?: string | null;
  cryptosuite?: string | null;
  proofCreated?: string | null;
  vcSignedAt?: string | null;
  vcKeyId?: string | null;
  anchorStatus?: string | null;
  credentialStatus?: {
    statusListCredential?: string;
    statusListIndex?: string;
  } | null;
  statusList?: { listId: number; index: number } | null;
  anchor?: TechnicalAnchor | null;
}

const CHECK_UI: Record<CheckOutcome, { icon: string; className: string; label: string }> = {
  PASS: { icon: "✓", className: "check-passed", label: "Амжилттай" },
  FAIL: { icon: "⨯", className: "check-failed", label: "Амжилтгүй" },
  PENDING: { icon: "◷", className: "check-pending", label: "Хүлээгдэж байна" },
  UNAVAILABLE: { icon: "!", className: "check-unavailable", label: "Шалгах боломжгүй" },
  SKIPPED: { icon: "–", className: "check-skipped", label: "Алгассан" },
};

const CHECK_LABELS: { key: keyof VcChecks; mn: string; en: string }[] = [
  { key: "signature", mn: "Гарын үсэг шалгах", en: "Issuer signature" },
  { key: "revocation", mn: "Төлөв шалгах", en: "Revocation status" },
  { key: "anchor", mn: "Нийтийн нотолгоо", en: "Public proof (anchor)" },
];

export function VcChecksPanel({
  checks,
  details,
}: {
  checks: VcChecks;
  details?: string[];
}) {
  return (
    <section className="card" aria-label="Шалгалтууд">
      {CHECK_LABELS.map(({ key, mn, en }) => {
        const ui = CHECK_UI[checks[key]];
        return (
          <div className="check-row" key={key}>
            <span className={ui.className} aria-hidden>
              {ui.icon}
            </span>
            <span>
              {mn} · {en}
              <span className={`check-outcome ${ui.className}`}> — {ui.label}</span>
            </span>
          </div>
        );
      })}
      {details && details.length > 0 && (
        <ul className="check-details">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function explorerTxUrl(chainId: number, txHash: string): string | null {
  if (chainId === 1) return `https://etherscan.io/tx/${txHash}`;
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
  return null;
}

export function TechnicalPanel({ technical }: { technical: TechnicalInfo }) {
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [];
  const push = (label: string, value: React.ReactNode, mono = true) => {
    if (value) rows.push({ label, value, mono });
  };

  push("Issuer DID", technical.issuerDid ?? technical.verificationMethod?.split("#")[0]);
  push("Түлхүүр · Key", technical.verificationMethod ?? technical.vcKeyId);
  push("Криптосьют · Cryptosuite", technical.cryptosuite);
  if (technical.vcSignedAt) {
    push("Гарын үсэг зурсан · Signed at", new Date(technical.vcSignedAt).toISOString());
  }
  if (technical.proofCreated) {
    push("Гарын үсэг зурсан · Signed at", technical.proofCreated);
  }
  const status = technical.credentialStatus;
  if (status?.statusListCredential) {
    push(
      "Статус жагсаалт · Status list",
      `${status.statusListCredential}#${status.statusListIndex ?? ""}`,
    );
  } else if (technical.statusList) {
    push(
      "Статус жагсаалт · Status list",
      `/status/${technical.statusList.listId}#${technical.statusList.index}`,
    );
  }

  const anchor = technical.anchor;
  if (anchor) {
    push("Меркл язгуур · Merkle root", anchor.merkleRoot);
    push("Багц · Anchor batch", `${anchor.batchId} (${anchor.status})`);
    if (anchor.txHash) {
      const url = explorerTxUrl(anchor.chainId, anchor.txHash);
      push(
        "Ethereum гүйлгээ · Transaction",
        url ? (
          <a href={url} target="_blank" rel="noreferrer noopener">
            {anchor.txHash}
          </a>
        ) : (
          anchor.txHash
        ),
      );
    }
    if (anchor.blockNumber) {
      push("Блок · Block", `${anchor.blockNumber} (chain ${anchor.chainId})`);
    }
    push("Гэрээ · Contract", anchor.contractAddress);
  } else if (technical.anchorStatus && technical.anchorStatus !== "CONFIRMED") {
    push("Нийтийн нотолгоо · Public proof", "Хүлээгдэж байна · pending", false);
  }

  if (rows.length === 0) return null;
  return (
    <section className="card" aria-label="Техникийн баталгаа">
      <h2 className="tech-title">Техникийн баталгаа · Technical proof</h2>
      <dl className="tech-list">
        {rows.map((r, i) => (
          <div className="tech-row" key={i}>
            <dt>{r.label}</dt>
            <dd className={r.mono ? "mono" : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
