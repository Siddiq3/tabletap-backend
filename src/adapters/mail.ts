// Outgoing email. MAILER=resend in staging/production, MAILER=console on your computer.
import type { Mailer } from "../ports";
import { env } from "../env";

type Email = { to: string; subject: string; text: string };

const codeEmail = (to: string, code: string): Email => ({
  to,
  subject: `${code} is your Tabletap code`,
  text: `Your Tabletap verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't sign up for Tabletap, ignore this email.`,
});

const resetEmail = (to: string, link: string): Email => ({
  to,
  subject: "Reset your Tabletap password",
  text: `Open this link to choose a new password:\n\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
});

function mailer(send: (e: Email) => Promise<void>): Mailer {
  return {
    sendVerificationCode: (to, code) => send(codeEmail(to, code)),
    sendPasswordReset: (to, link) => send(resetEmail(to, link)),
  };
}

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email); no SDK. */
export const resendMailer = mailer(async ({ to, subject, text }) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("MAIL_FROM"), to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().catch(() => "")}`);
});

/** Local dev: prints the email instead of sending it. */
export const consoleMailer = mailer(async ({ to, subject, text }) => {
  console.log(`\n[mail] to: ${to}\n[mail] subject: ${subject}\n${text}\n`);
});
