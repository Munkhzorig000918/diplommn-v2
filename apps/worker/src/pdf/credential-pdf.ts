import { fileURLToPath } from "node:url";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

/**
 * Credential verification document (A4). This artifact is a *verification
 * companion* to the credential record — its legal status as the diploma
 * itself is an open policy decision (architecture gap #21), so the wording
 * stays honest about what it is.
 *
 * QR rules (D2V2 §18): encodes only the public verification URL; printed
 * beside it are the human-readable certificate ID and the official domain,
 * as camera-free fallback. High contrast, generous quiet zone.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.resolve(here, "../../assets/fonts/NotoSans-Regular.ttf");
const FONT_BOLD = path.resolve(here, "../../assets/fonts/NotoSans-Bold.ttf");

export interface CredentialPdfData {
  holderName: string;
  institutionMn: string;
  institutionEn: string;
  credentialTypeMn: string;
  credentialTypeEn: string;
  credentialNumber: string | null;
  certificateIdFormatted: string;
  program: string | null;
  degree: string | null;
  awardedDate: string | null;
  issuedAt: string;
  verifyUrl: string;
}

const INK = "#17202b";
const MUTED = "#4e5d6c";
const PRIMARY = "#174e8c";
const DIVIDER = "#c8d1dc";

export async function renderCredentialPdf(
  data: CredentialPdfData,
): Promise<Buffer> {
  const qrPng = await QRCode.toBuffer(data.verifyUrl, {
    type: "png",
    errorCorrectionLevel: "Q",
    margin: 4,
    width: 480,
    color: { dark: "#000000", light: "#ffffff" },
  });

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `diplom.mn verification document ${data.certificateIdFormatted}`,
      Author: "diplom.mn",
    },
  });
  doc.registerFont("regular", FONT_REGULAR);
  doc.registerFont("bold", FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 112;

  // Header band
  doc.rect(0, 0, pageWidth, 96).fill("#142235");
  doc
    .font("bold")
    .fontSize(20)
    .fillColor("#ffffff")
    .text("diplom.mn", 56, 28);
  doc
    .font("regular")
    .fontSize(10)
    .fillColor("#b9c5d4")
    .text("Дипломын баталгаажуулалтын үйлчилгээ · Diploma verification service", 56, 56);

  // Title
  doc
    .font("bold")
    .fontSize(15)
    .fillColor(INK)
    .text("БАРИМТЫН БАТАЛГААЖУУЛАХ ХУУДАС", 56, 128, { width: contentWidth });
  doc
    .font("regular")
    .fontSize(10)
    .fillColor(MUTED)
    .text("CREDENTIAL VERIFICATION DOCUMENT", { width: contentWidth });

  doc
    .moveTo(56, doc.y + 12)
    .lineTo(pageWidth - 56, doc.y + 12)
    .strokeColor(DIVIDER)
    .lineWidth(1)
    .stroke();

  // Field rows — compact so the whole document always fits one A4 page.
  let y = doc.y + 24;
  const row = (labelMn: string, labelEn: string, value: string) => {
    doc.font("regular").fontSize(8).fillColor(MUTED).text(`${labelMn} · ${labelEn}`, 56, y, {
      width: contentWidth,
    });
    doc.font("bold").fontSize(11).fillColor(INK).text(value, 56, y + 11, {
      width: contentWidth,
    });
    y = doc.y + 7;
  };

  row("Эзэмшигч", "Holder", data.holderName);
  row("Байгууллага", "Institution", `${data.institutionMn}\n${data.institutionEn}`);
  row("Баримтын төрөл", "Credential type", `${data.credentialTypeMn} · ${data.credentialTypeEn}`);
  if (data.program) row("Хөтөлбөр", "Program", data.program);
  if (data.degree) row("Зэрэг", "Degree", data.degree);
  if (data.awardedDate) row("Төгссөн огноо", "Awarded", data.awardedDate);
  if (data.credentialNumber) row("Баримтын дугаар", "Document №", data.credentialNumber);
  row("Олгосон огноо", "Issued", data.issuedAt);

  // Verification block: QR right, instructions left. Fixed position — field
  // rows above are sized to always finish before this line (A4 = 842pt tall).
  const qrSize = 126;
  const blockTop = Math.min(Math.max(y + 12, 480), 540);
  const qrX = pageWidth - 56 - qrSize;

  doc
    .moveTo(56, blockTop - 12)
    .lineTo(pageWidth - 56, blockTop - 12)
    .strokeColor(DIVIDER)
    .stroke();

  doc.image(qrPng, qrX, blockTop, { width: qrSize, height: qrSize });
  doc
    .font("regular")
    .fontSize(7.5)
    .fillColor(MUTED)
    .text("diplom.mn/verify", qrX, blockTop + qrSize + 6, {
      width: qrSize,
      align: "center",
    });

  doc
    .font("bold")
    .fontSize(11)
    .fillColor(PRIMARY)
    .text("Баталгаажуулалт · Verification", 56, blockTop, {
      width: contentWidth - qrSize - 24,
    });
  doc
    .font("regular")
    .fontSize(9)
    .fillColor(INK)
    .text(
      "QR кодыг уншуулах эсвэл diplom.mn/verify хуудсанд доорх сертификатын дугаарыг оруулж, энэ баримтын үнэн зөвийг хэдийд ч, нэвтрэхгүйгээр шалгана уу. · Scan the QR code or enter the certificate ID below at diplom.mn/verify to check this document's authenticity at any time — no login required.",
      56,
      doc.y + 6,
      { width: contentWidth - qrSize - 24 },
    );

  doc
    .font("regular")
    .fontSize(8)
    .fillColor(MUTED)
    .text("Сертификатын дугаар · Certificate ID", 56, doc.y + 12, {
      width: contentWidth - qrSize - 24,
    });
  doc
    .font("bold")
    .fontSize(14)
    .fillColor(INK)
    .text(data.certificateIdFormatted, 56, doc.y + 2, {
      characterSpacing: 1,
      width: contentWidth - qrSize - 24,
      lineBreak: false,
    });

  // Footer — height-capped so it can never trigger an automatic page break.
  doc
    .font("regular")
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(
      "Энэ хуудас нь diplom.mn системд бүртгэлтэй баримтын баталгаажуулах хуудас бөгөөд баримтын одоогийн төлөвийг зөвхөн diplom.mn/verify харуулна. · This page is a verification companion to the record held by diplom.mn; the credential's current status is authoritative only at diplom.mn/verify.",
      56,
      748,
      { width: contentWidth, height: 36, ellipsis: false },
    );

  doc.end();
  return done;
}
