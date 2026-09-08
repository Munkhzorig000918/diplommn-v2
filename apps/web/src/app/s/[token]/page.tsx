import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

/**
 * Public share-link landing. An active link resolves to the standard public
 * verification result (one verification code path); a dead link explains that
 * the LINK is unavailable without implying anything about the credential.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Хуваалцсан баримт — diplom.mn",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let status = "UNAVAILABLE";
  let certificateId: string | null = null;
  try {
    const res = await fetch(
      `${API_URL}/api/v1/share/${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        share: { status: string };
        certificateId?: string | null;
      };
      status = body.share.status;
      certificateId = body.certificateId ?? null;
    }
  } catch {
    status = "UNAVAILABLE";
  }

  if (status === "ACTIVE" && certificateId) {
    redirect(`/verify/${certificateId.replaceAll("-", "")}`);
  }

  const explanation: Record<string, string> = {
    EXPIRED:
      "Энэ хуваалцах холбоосны хугацаа дууссан байна. · This share link has expired.",
    REVOKED:
      "Эзэмшигч энэ холбоосыг хүчингүй болгосон байна. · The holder has revoked this link.",
    NOT_FOUND:
      "Энэ хуваалцах холбоос олдсонгүй. · This share link was not found.",
    UNAVAILABLE:
      "Холбоосыг одоогоор шалгах боломжгүй байна — дараа дахин оролдоно уу. · The link cannot be checked right now — please retry later.",
  };

  return (
    <>
      <section className="result-panel result-notfound" role="status">
        <div className="result-title">
          <span aria-hidden>ⓘ</span> Холбоос идэвхгүй · Link not active
        </div>
        <p className="result-meaning">{explanation[status] ?? explanation.UNAVAILABLE}</p>
        <p className="result-meta">
          Энэ нь баримтын хүчинтэй байдлын тухай дүгнэлт БИШ — зөвхөн холбоос
          идэвхгүй гэсэн үг. · This is NOT a statement about the credential
          itself — only about the link.
        </p>
      </section>
      <p>
        <Link href="/verify">
          Сертификатын дугаараар шалгах · Verify by certificate ID →
        </Link>
      </p>
    </>
  );
}
