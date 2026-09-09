import type { Metadata } from "next";
import { Noto_Sans, Noto_Sans_Mono } from "next/font/google";
import "./globals.css";

const notoSans = Noto_Sans({
  subsets: ["latin", "cyrillic"],
  variable: "--font-sans",
});
const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "diplom.mn — Диплом баталгаажуулах",
  description:
    "Диплом, гэрчилгээний үнэн зөвийг баталгаажуулах үндэсний үйлчилгээ",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="mn" className={`${notoSans.variable} ${notoSansMono.variable}`}>
      <body style={{ fontFamily: "var(--font-sans), sans-serif" }}>
        <header className="site-header">
          <div className="site-header-row">
            <div>
              <a className="brand" href="/">
                diplom.mn
              </a>
              <div className="tagline">
                Дипломын баталгаажуулалтын үйлчилгээ · Diploma verification
                service
              </div>
            </div>
            <nav className="site-nav" aria-label="Үндсэн цэс">
              <a href="/">Нүүр</a>
              <a href="/verify">Баталгаажуулах</a>
              <a href="/portal/login">Нэвтрэх</a>
            </nav>
          </div>
        </header>
        <main className="page">{children}</main>
        <footer className="site-footer">
          <div className="site-footer-grid">
            <div>
              <div className="brand">diplom.mn</div>
              <p className="footer-muted">
                Боловсролын баримт бичгийн
                <br />
                баталгаажуулалтын систем
              </p>
            </div>
            <div>
              <h3>Үйлчилгээ</h3>
              <a href="/verify">Баримт шалгах</a>
              <a href="/portal/login">Миний баримтууд</a>
            </div>
            <div>
              <h3>Тусламж</h3>
              <a href="/verify">Түгээмэл асуулт</a>
              <a href="/status/1">Статус жагсаалт</a>
            </div>
            <div>
              <h3>Холбоо барих</h3>
              <p className="footer-muted">
                и-мэйл: info@diplom.mn
                <br />© 2026 diplom.mn
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
