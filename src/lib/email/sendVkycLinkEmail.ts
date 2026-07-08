/**
 * Passive Video KYC link email — Addendum V0.3.1 §11.
 *
 * Sends the single-use video-KYC capture link to the customer. The customer
 * opens it on their phone/laptop and records a short live selfie video, which
 * is scored by Decentro's passive liveness engine. Mirrors
 * sendFiAgentLinkEmail's nodemailer/getMailer pattern. Minimal context only.
 */
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface VkycLinkEmailPayload {
  toEmail: string;
  customerName: string;
  url: string;
  /** When the link stops working. */
  expiresAt: Date;
}

export async function sendVkycLinkEmail(p: VkycLinkEmailPayload): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = "iTarang — Complete your video verification";
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Hello ${esc(p.customerName)},</p>
      <p>To complete your loan application we need a quick <b>video verification</b>.
        It takes under a minute — just open the link below and record a short selfie
        video when prompted.</p>
      <p>Open this single-use link on a device with a camera. It expires on
        <b>${esc(p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST</b>.</p>
      <p style="margin:20px 0">
        <a href="${esc(p.url)}" style="background:#0f2540;color:#fff;text-decoration:none;
          padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Start video verification</a>
      </p>
      <p style="color:#64748b;font-size:12px">If the button doesn't work, paste this link into your browser:<br>${esc(p.url)}</p>
      <p style="color:#94a3b8;font-size:12px">This link is for you only. Camera access is required to record the video.</p>
    </div>`;
  const info = await transporter.sendMail({ from, to: p.toEmail, subject, html });
  return { ok: true, messageId: info.messageId };
}
