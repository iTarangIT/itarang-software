/**
 * Dealer onboarding "continue your application" code — tracker ID 129.
 *
 * Sent to the owner e-mail already ON the application, never to an address the
 * request supplies: receiving it is the proof that the person at the form is
 * the dealer the application belongs to. Mirrors sendPasswordChangeOtpEmail.ts
 * (a text part alongside the HTML, for deliverability on the AgentMail path).
 */
import { getMailer } from "./mailer";
import { RESUME_OTP_TTL_MS } from "@/lib/onboarding/submitAccess";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface OnboardingResumeOtpEmailPayload {
  toEmail: string;
  ownerName: string | null;
  companyName: string | null;
  code: string;
  expiresAt: Date;
}

export async function sendOnboardingResumeOtpEmail(
  p: OnboardingResumeOtpEmailPayload,
): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM;
  const subject = "iTarang — code to continue your dealer application";
  const minutes = Math.round(RESUME_OTP_TTL_MS / 60_000);
  const expiry = `${p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;
  const who = p.ownerName?.trim() || "there";
  const what = p.companyName?.trim() ? ` for <b>${esc(p.companyName.trim())}</b>` : "";
  const whatText = p.companyName?.trim() ? ` for ${p.companyName.trim()}` : "";

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;max-width:640px">
      <p>Hello ${esc(who)},</p>
      <p>Someone is continuing the <b>iTarang</b> dealer onboarding application${what}.
         Enter this code on the form to confirm it is you:</p>
      <p style="margin:24px 0">
        <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;
          padding:14px 26px;font-size:26px;font-weight:700;letter-spacing:8px;color:#005596">${esc(p.code)}</span>
      </p>
      <p>The code is valid for <b>${minutes} minutes</b> (until ${esc(expiry)}) and can be used once.</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="color:#b91c1c;font-size:12px">
        <b>If this was not you, do not share the code.</b> Nothing on your application changes without it.
        Tell your iTarang sales contact, or write to
        <a href="mailto:it@itarang.com" style="color:#b91c1c">it@itarang.com</a>.
      </p>
      <p style="color:#94a3b8;font-size:12px">iTarang EV Technologies Pvt Ltd</p>
    </div>`;

  const text = [
    `Hello ${who},`,
    ``,
    `Someone is continuing the iTarang dealer onboarding application${whatText}.`,
    `Enter this code on the form to confirm it is you:`,
    ``,
    `    ${p.code}`,
    ``,
    `The code is valid for ${minutes} minutes (until ${expiry}) and can be used once.`,
    ``,
    `If this was not you, do not share the code. Nothing on your application changes without it.`,
    `Tell your iTarang sales contact, or write to it@itarang.com.`,
    ``,
    `iTarang EV Technologies Pvt Ltd`,
  ].join("\n");

  const info = await transporter.sendMail({
    from,
    to: p.toEmail,
    replyTo: "it@itarang.com",
    subject,
    html,
    text,
  });
  return { ok: true, messageId: String(info?.messageId ?? "") };
}
