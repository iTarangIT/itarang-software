/**
 * Password-reset link email — E-212, the "Forgot password?" flow on /login.
 *
 * Mirrors sendVkycLinkEmail's getMailer/inline-HTML pattern, with three
 * deliberate deltas because this is a security email rather than a workflow
 * nudge:
 *
 *   1. `replyTo` is set. On the AgentMail path getMailer() DISCARDS `from` and
 *      sends as the inbox itself (care-itarang@agentmail.to) — see the header
 *      of ./mailer.ts. A reply-to at least routes a confused user's "is this
 *      real?" reply back to us.
 *   2. A `text` part is sent alongside the HTML. HTML-only single-link mail
 *      scores badly with spam filters, and this one already carries the
 *      handicap that agentmail.to has no SPF/DKIM alignment with itarang.com.
 *      Corporate Google Workspace / M365 tenants — which is what NBFC partners
 *      and internal ceo/admin users are on — filter unaligned reset mail
 *      aggressively. The durable fix is configuration, not code: verify a
 *      custom sending domain in AgentMail and repoint AGENTMAIL_INBOX.
 *   3. `from` is process.env.MAIL_FROM only, without sendVkycLinkEmail's
 *      `|| process.env.SMTP_USER` fallback — SMTP_USER is commented out in
 *      .env.local, so that fallback resolves to undefined anyway.
 */
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PasswordResetEmailPayload {
  toEmail: string;
  userName: string;
  url: string;
  /** When the link stops working. */
  expiresAt: Date;
}

export async function sendPasswordResetEmail(
  p: PasswordResetEmailPayload,
): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM;
  const subject = "iTarang — reset your password";
  const expiry = `${p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;max-width:640px">
      <p>Hello ${esc(p.userName)},</p>
      <p>We received a request to reset the password for your <b>iTarang</b> account
        (${esc(p.toEmail)}). Click the button below to choose a new password.</p>
      <p style="margin:24px 0">
        <a href="${esc(p.url)}" style="background:#005596;color:#fff;text-decoration:none;
          padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Reset my password</a>
      </p>
      <p>This link can be used <b>once</b> and expires on <b>${esc(expiry)}</b>.</p>
      <p style="color:#64748b;font-size:12px">If the button doesn't work, paste this link into your browser:<br>${esc(p.url)}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="color:#64748b;font-size:12px">
        If you didn't request this, you can ignore this email — your password has not been
        changed and the link above will expire on its own.
      </p>
      <p style="color:#94a3b8;font-size:12px">iTarang EV Technologies Pvt Ltd</p>
    </div>`;

  const text = [
    `Hello ${p.userName},`,
    ``,
    `We received a request to reset the password for your iTarang account (${p.toEmail}).`,
    `Open this link to choose a new password:`,
    ``,
    p.url,
    ``,
    `This link can be used once and expires on ${expiry}.`,
    ``,
    `If you didn't request this, ignore this email — your password has not been changed.`,
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
