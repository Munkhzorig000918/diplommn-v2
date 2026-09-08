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
          <a className="brand" href="/verify">
            diplom.mn
          </a>
          <div className="tagline">
            Дипломын баталгаажуулалтын үйлчилгээ · Diploma verification service
          </div>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
