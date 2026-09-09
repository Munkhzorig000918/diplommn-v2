import type { Metadata } from "next";
import Link from "next/link";

/**
 * PUB "Итгэл ба Нууцлал" — the trust architecture explained for lay
 * readers (Figma Privacy Page): who validates what, what is stored where,
 * how independent verification works, and what happens during outages.
 * Blockchain appears only as "Нийтийн нотолгоо" per the design's UX rules.
 */
export const metadata: Metadata = {
  title: "Итгэл ба Нууцлал — diplom.mn",
};

export default function TrustPage() {
  return (
    <>
      <h1>Итгэл ба Нууцлал</h1>
      <p className="subtitle">
        diplom.mn системд итгэх үндэслэл: мэдээлэл хаана хадгалагдаж, хэн
        баталгаажуулж, та хэрхэн хөндлөнгөөс шалгаж болохыг энд тайлбарлав.
      </p>

      <section className="card">
        <h2 className="trust-h2">Итгэлийн гинжин хэлхээ</h2>
        <div className="trust-chain">
          <div className="trust-node">
            <strong>Боловсролын мэдээллийн сан</strong>
            <p>Төгсөлтийн бүртгэлийн албан эх сурвалж — олголт бүр эндээс тулгагдана.</p>
          </div>
          <span className="trust-arrow" aria-hidden>→</span>
          <div className="trust-node">
            <strong>diplom.mn</strong>
            <p>Хоёр шатлалт хяналтаар (оруулагч ≠ батлагч) баримтыг олгож, гарын үсэг зурна.</p>
          </div>
          <span className="trust-arrow" aria-hidden>→</span>
          <div className="trust-node">
            <strong>Нийтийн нотолгоо</strong>
            <p>Өдөр бүр криптограф хураангуй нээлттэй сүлжээнд бичигдэж, хэн ч шалгана.</p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="trust-h2">Таны мэдээлэл хаана хадгалагддаг вэ?</h2>
        <div className="trust-cols">
          <div>
            <h3 className="trust-h3">Монгол дахь дата төвд (хамгаалагдсан)</h3>
            <ul className="trust-list">
              <li>Хувийн мэдээлэл, дипломын бүрэн агуулга</li>
              <li>Гарын үсэгтэй цахим баримтууд (VC)</li>
              <li>PDF хуулбар, QR холбоосууд</li>
              <li>Бүх үйлдлийн өөрчлөгдөшгүй бүртгэл</li>
            </ul>
          </div>
          <div>
            <h3 className="trust-h3">Нээлттэй сүлжээнд (нийтэд ил)</h3>
            <ul className="trust-list">
              <li>Зөвхөн өдрийн нэгдсэн криптограф хураангуй (хеш)</li>
              <li>Хувийн мэдээлэл, нэр, дугаар — ХЭЗЭЭ Ч байршихгүй</li>
              <li>Хураангуйгаас эх мэдээллийг сэргээх боломжгүй</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="trust-h2">Баталгаажуулалт хэрхэн ажилладаг вэ?</h2>
        <ol className="trust-steps">
          <li>
            <strong>Гарын үсэг шалгах</strong> — баримт diplom.mn-ий албан
            түлхүүрээр зурагдсан, өөрчлөгдөөгүй гэдгийг криптографаар батална.
          </li>
          <li>
            <strong>Эх сурвалжийн тулгалт</strong> — олголтын үед боловсролын
            албан бүртгэлтэй тулгасан нотолгоог хадгална.
          </li>
          <li>
            <strong>Төлөв шалгах</strong> — баримт цуцлагдсан эсэхийг нээлттэй
            статус жагсаалтаас шалгана.
          </li>
          <li>
            <strong>Нийтийн нотолгоо</strong> — баримтын хураангуй тухайн өдрийн
            нээлттэй бичилтэд багтсаныг математикийн аргаар батална.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2 className="trust-h2">Систем тасалдвал яах вэ?</h2>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Аль хэдийн олгогдсон баримтын баталгаажуулалт diplom.mn-ий сервер
          ажиллахгүй байсан ч боломжтой хэвээр байна: гарт байгаа цахим баримт +
          нээлттэй сүлжээн дэх нотолгоо хоёр л хангалттай. Сүлжээний саатал
          хэзээ ч «хуурамч» гэсэн дүгнэлт болохгүй — ийм үед үр дүн
          «Тодорхойлох боломжгүй» гэж шударгаар харагдана.
        </p>
      </section>

      <section className="card">
        <h2 className="trust-h2">Техникийн сонирхолтой хүмүүст</h2>
        <dl className="tech-list">
          <div className="tech-row">
            <dt>Олгогчийн тодорхойлогч</dt>
            <dd className="mono">did:web:diplom.mn</dd>
          </div>
          <div className="tech-row">
            <dt>Баримтын стандарт</dt>
            <dd>W3C Verifiable Credentials 2.0 · DataIntegrityProof (ecdsa-jcs-2019)</dd>
          </div>
          <div className="tech-row">
            <dt>Статус жагсаалт</dt>
            <dd>W3C Bitstring Status List</dd>
          </div>
          <div className="tech-row">
            <dt>Нийтийн нотолгоо</dt>
            <dd>Өдөр тутмын Merkle root — Ethereum L1 дээрх өөрчлөгдөшгүй бүртгэлд</dd>
          </div>
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          Нээлттэй шалгагчаар бие даан шалгах боломжтой —{" "}
          <Link href="/verify">баталгаажуулах хуудас</Link> дээрх «VC файл
          оруулах» аргыг ашиглана уу.
        </p>
      </section>
    </>
  );
}
