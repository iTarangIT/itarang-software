/**
 * Field Investigation agent link email — BRD Addendum V0.3.1 §10.6.
 *
 * Sends the single-use field-form link to an FI agent. Email is the universal
 * default channel (v1 stance Gamma) — no NBFC gateway setup required. Mirrors
 * sendManualHandoffEmail's nodemailer/getMailer pattern. Minimal context only
 * (customer name + city), since the link itself carries the address (§10.7).
 */
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface FiAgentLinkEmailPayload {
  toEmail: string;
  agentName: string;
  customerName: string;
  city?: string | null;
  url: string;
  /** SLA deadline shown to the agent. */
  expiresAt: Date;
}

export async function sendFiAgentLinkEmail(p: FiAgentLinkEmailPayload): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `iTarang — Field verification visit assigned${p.city ? ` (${p.city})` : ""}`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Hello ${esc(p.agentName)},</p>
      <p>You have been assigned a field verification visit for customer
        <b>${esc(p.customerName)}</b>${p.city ? ` in ${esc(p.city)}` : ""}.</p>
      <p>Open this single-use link <b>on your phone, at the customer's address</b>.
        It captures your location and photos and expires on
        <b>${esc(p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST</b>.</p>
      <p style="margin:20px 0">
        <a href="${esc(p.url)}" style="background:#0f2540;color:#fff;text-decoration:none;
          padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Start the visit</a>
      </p>
      <p style="color:#64748b;font-size:12px">If the button doesn't work, paste this link into your phone's browser:<br>${esc(p.url)}</p>
      <p style="color:#94a3b8;font-size:12px">This link is for the assigned agent only. Location access is required to submit.</p>
    </div>`;
  const info = await transporter.sendMail({ from, to: p.toEmail, subject, html });
  return { ok: true, messageId: info.messageId };
}
