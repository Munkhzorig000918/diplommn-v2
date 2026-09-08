import nodemailer, { type Transporter } from "nodemailer";

/**
 * Notification provider abstraction (design doc: providers are external and
 * pluggable; delivery failures must never roll back issuance).
 *
 * - `SMTP_URL` set → real SMTP delivery via nodemailer
 *   (e.g. smtp://user:pass@mail.example.mn:587)
 * - otherwise → console provider (development), which logs the message.
 *
 * Message bodies must never contain registration numbers, claims payloads or
 * secrets beyond what the recipient already owns (D2V2 §23.3).
 */

export interface Notifier {
  readonly kind: "smtp" | "console";
  sendEmail(to: string, subject: string, text: string): Promise<void>;
}

export function createNotifier(): Notifier {
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.SMTP_FROM ?? "no-reply@diplom.mn";

  if (smtpUrl) {
    const transporter: Transporter = nodemailer.createTransport(smtpUrl);
    return {
      kind: "smtp",
      async sendEmail(to, subject, text) {
        await transporter.sendMail({ from, to, subject, text });
      },
    };
  }

  return {
    kind: "console",
    async sendEmail(to, subject, text) {
      console.log(
        `[notify:console] to=${to} subject="${subject}"\n${text
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")}`,
      );
    },
  };
}
