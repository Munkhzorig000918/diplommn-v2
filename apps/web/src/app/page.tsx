import Link from "next/link";

/**
 * PUB-001 — public landing (Astra 01). Trust-first government tone: what
 * the platform does, who can verify, how the public proof works. The
 * verifier itself stays one click away and login-free.
 */
export const metadata = {
  title: "diplom.mn — Диплом, гэрчилгээ баталгаажуулалтын цогц платформ",
};

const FEATURES = [
  {
    icon: "🛡",
    title: "Нэвтрэлт шаардлагагүй",
    text: "Хэн ч дипломын үнэн зөвийг бүртгэлгүйгээр, хэдхэн секундэд шалгана.",
  },
  {
    icon: "🏛",
    title: "Эх сурвалжаас баталгаажсан",
    text: "Мэдээлэл боловсролын салбарын албан эх сурвалжтай тулгагдаж олгогдоно.",
  },
  {
    icon: "🔗",
    title: "Нийтийн нотолгоотой",
    text: "Өдөр бүр криптограф нотолгоо нээлттэй сүлжээнд бичигдэж, хэн ч хөндлөнгөөс шалгах боломжтой.",
  },
  {
    icon: "🔒",
    title: "Нууцлал хамгаалагдсан",
    text: "Хувийн мэдээлэл нээлттэй сүлжээнд хэзээ ч хадгалагдахгүй — зөвхөн хэш утга нийтлэгдэнэ.",
  },
  {
    icon: "⏳",
    title: "Урт хугацаанд хүчинтэй",
    text: "Гарын үсэгтэй цахим баримт олон жилийн дараа ч бие даан шалгагдана.",
  },
];

export default function LandingPage() {
  return (
    <>
      <section className="hero">
        <div>
          <h1 className="hero-title">
            Диплом, гэрчилгээ баталгаажуулалтын цогц платформ
          </h1>
          <p className="subtitle">
            Боловсролын баримт бичгийн үнэн зөвийг иргэн, байгууллага хэн ч
            хурдан бөгөөд найдвартай шалгах үндэсний үйлчилгээ. · Verify
            Mongolian diplomas and certificates — fast, free, trustworthy.
          </p>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <Link className="btn-primary" style={{ marginTop: 0 }} href="/verify">
              🛡 Баталгаажуулах · Verify
            </Link>
            <Link className="btn-secondary" href="/portal/login">
              Миний баримтууд · My credentials
            </Link>
          </div>
        </div>
      </section>

      <section className="feature-grid" aria-label="Давуу талууд">
        {FEATURES.map((f) => (
          <div className="feature-card" key={f.title}>
            <span className="method-icon" aria-hidden>
              {f.icon}
            </span>
            <h2 className="feature-title">{f.title}</h2>
            <p className="feature-text">{f.text}</p>
          </div>
        ))}
      </section>

      <section className="card" aria-label="Нийтийн нотолгоо">
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>
          «Нийтийн нотолгоо» гэж юу вэ?
        </h2>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Олгогдсон баримт бүрийн криптограф хураангуй (хеш) өдөр бүр нэгтгэгдэж
          нээлттэй сүлжээнд бичигдэнэ. Ингэснээр diplom.mn-ий систем түр
          ажиллахгүй байсан ч, олон жилийн дараа ч баримтын үнэн зөвийг хэн ч
          хөндлөнгөөс, бие даан шалгаж чадна. Хувийн мэдээлэл нээлттэй сүлжээнд
          хэзээ ч байршихгүй.
        </p>
      </section>
    </>
  );
}
