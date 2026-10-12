// Outbound email (2026-10-12).
//
// Only transactional mail so far: the password-reset link. Credentials come
// from the environment — never from source, never from the database — so a
// copy of this repo carries no mailbox access. Without SMTP_HOST/SMTP_USER
// the app still runs; the reset route logs the link instead of sending it,
// which is what local development uses.
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

const FROM = process.env.MAIL_FROM || "TekRevol FinSys <no-reply@tekrevol.com>";

export function mailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let cached: Transporter | null = null;

function transport(): Transporter {
  if (cached) return cached;
  const port = Number(process.env.SMTP_PORT || 587);
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Port 465 is implicit TLS; 587 starts plaintext and upgrades with
    // STARTTLS, which `requireTLS` makes mandatory rather than best-effort.
    secure: String(process.env.SMTP_SECURE ?? (port === 465)) === "true",
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return cached;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Sends the reset link. Resolves to false when no SMTP is configured (the
 * caller logs the link instead); throws only when a configured server
 * rejected the message, which the caller swallows so the HTTP response
 * never reveals whether the address exists.
 */
export async function sendPasswordResetEmail(to: string, name: string, link: string, ttlMinutes: number): Promise<boolean> {
  if (!mailConfigured()) return false;
  const safeLink = escapeHtml(link);
  await transport().sendMail({
    from: FROM,
    to,
    subject: "Reset your TekRevol FinSys password",
    text: [
      `Hi ${name},`,
      "",
      "Use this link to choose a new password:",
      link,
      "",
      `The link expires in ${ttlMinutes} minutes and can only be used once.`,
      "If you didn't ask for this, you can ignore this email — your password stays as it is.",
    ].join("\n"),
    html: [
      `<p>Hi ${escapeHtml(name)},</p>`,
      `<p><a href="${safeLink}">Choose a new password</a></p>`,
      `<p style="color:#64748B;font-size:13px">The link expires in ${ttlMinutes} minutes and can only be used once.`,
      ` If you didn't ask for this, you can ignore this email — your password stays as it is.</p>`,
      `<p style="color:#94A3B8;font-size:12px">${safeLink}</p>`,
    ].join(""),
  });
  return true;
}
