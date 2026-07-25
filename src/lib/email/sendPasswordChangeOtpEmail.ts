/**
 * Change-password OTP email — E-213, the in-app "Change Password" modal.
 *
 * Mirrors sendPasswordResetEmail.ts, including its two deliverability
 * measures (a `replyTo`, and a `text` part alongside the HTML) — see that
 * file's header for why they matter on the AgentMail path, where `from` is
 * discarded and mail leaves as care-itarang@agentmail.to with no SPF/DKIM
 * alignment to itarang.com.
 *
 * One copy difference from the reset email: the "you didn't request this"
 * line is stronger here. A reset link arriving unprompted means someone typed
 * your address into a public form; a CHANGE code arriving unprompted means
 * someone is holding a live authenticated session as you.
 */
import { getMailer } from "./mailer";
import { OTP_TTL_MS } from "@/lib/auth/password-change-otp";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PasswordChangeOtpEmailPayload {
  toEmail: string;
  userName: string;
  code: string;
  expiresAt: Date;
}

export async function sendPasswordChangeOtpEmail(
  p: PasswordChangeOtpEmailPayload,
): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM;
  const subject = "iTarang — your password change code";
  const minutes = Math.round(OTP_TTL_MS / 60_000);
  const expiry = `${p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;max-width:640px">
      <p>Hello ${esc(p.userName)},</p>
      <p>Use this code to confirm the password change on your <b>iTarang</b> account:</p>
      <p style="margin:24px 0">
        <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;
          padding:14px 26px;font-size:26px;font-weight:700;letter-spacing:8px;color:#005596">${esc(p.code)}</span>
      </p>
      <p>The code is valid for <b>${minutes} minutes</b> (until ${esc(expiry)}) and can be used once.</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="color:#b91c1c;font-size:12px">
        <b>If you didn't request this, your password has NOT been changed</b> — but someone may be
        signed in to your account. Contact
        <a href="mailto:it@itarang.com" style="color:#b91c1c">it@itarang.com</a> immediately and do
        not share this code with anyone.
      </p>
      <p style="color:#94a3b8;font-size:12px">iTarang EV Technologies Pvt Ltd</p>
    </div>`;

  const text = [
    `Hello ${p.userName},`,
    ``,
    `Use this code to confirm the password change on your iTarang account:`,
    ``,
    `    ${p.code}`,
    ``,
    `The code is valid for ${minutes} minutes (until ${expiry}) and can be used once.`,
    ``,
    `If you didn't request this, your password has NOT been changed — but someone may be`,
    `signed in to your account. Contact it@itarang.com immediately and do not share this code.`,
    `iTarang EV Technologies Pvt Ltd`,
  ].join("\n");

  const info = await transporter.sendMail({
    from,
    replyTo: "it@itarang.com",
    to: p.toEmail,
    subject,
    html,
    text,
  });
  return { ok: true, messageId: info.messageId };
}
