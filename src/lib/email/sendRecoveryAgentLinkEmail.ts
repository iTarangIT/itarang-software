/**
 * E-262 — the collection job an agent receives.
 *
 * Sends the single-use link that opens the field form. Mirrors
 * sendFiAgentLinkEmail's getMailer/nodemailer pattern.
 *
 * MORE CONTEXT THAN THE FI EMAIL CARRIES, deliberately. An FI agent is sent to
 * verify an address, so the address is the whole job and the link holds it. A
 * recovery agent has to find a specific physical object at that address and
 * decide whether the thing in front of them is it — so the battery serial, the
 * borrower's name and their phone number travel in the email itself, where they
 * can be read without signal on a doorstep. The number is a `tel:` link because
 * this is read on a handset and ringing ahead is the first thing an agent does.
 *
 * Still no loan amount, no DPD, no outstanding: the agent collects a battery,
 * they are not there to discuss the debt, and a misdirected email should not
 * disclose somebody's arrears.
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

export interface RecoveryAgentLinkEmailPayload {
  toEmail: string;
  agentName: string;
  borrowerName: string;
  borrowerPhone?: string | null;
  address?: string | null;
  city?: string | null;
  batterySerial?: string | null;
  url: string;
  expiresAt: Date;
  /** The NBFC on whose behalf the agent is collecting. */
  nbfcName?: string | null;
  /** True on a re-send, so the agent knows it replaces an earlier link. */
  resend?: boolean;
}

export async function sendRecoveryAgentLinkEmail(
  p: RecoveryAgentLinkEmailPayload,
): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = p.resend
    ? `iTarang — Battery collection link re-sent${p.city ? ` (${p.city})` : ""}`
    : `iTarang — Battery collection assigned${p.city ? ` (${p.city})` : ""}`;

  const expiry = esc(
    p.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  );

  const row = (label: string, value: string | null | undefined) =>
    value
      ? `<tr>
           <td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;white-space:nowrap">${esc(label)}</td>
           <td style="padding:4px 0;font-size:13px;font-weight:600">${esc(value)}</td>
         </tr>`
      : "";

  // Tappable. The agent is reading this on the phone they are about to dial
  // from, and a number they have to retype is a number they do not ring.
  const phoneRow = (label: string, value: string | null | undefined) =>
    value
      ? `<tr>
           <td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;white-space:nowrap">${esc(label)}</td>
           <td style="padding:4px 0;font-size:13px;font-weight:600">
             <a href="tel:${esc(value.replace(/[^\d+]/g, ""))}" style="color:#0f2540">${esc(value)}</a>
           </td>
         </tr>`
      : "";

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Hello ${esc(p.agentName)},</p>
      <p>${
        p.resend
          ? "Here is your collection link again. It replaces the one sent earlier."
          : `You have been assigned a battery collection${p.nbfcName ? ` for ${esc(p.nbfcName)}` : ""}.`
      }</p>

      <table style="border-collapse:collapse;margin:16px 0">
        ${row("Borrower", p.borrowerName)}
        ${phoneRow("Borrower phone", p.borrowerPhone)}
        ${row("Battery serial", p.batterySerial)}
        ${row("Address", p.address)}
        ${row("City", p.city)}
      </table>

      <p>Open this single-use link <b>on your phone, at the address</b>. It records
        your location and the photographs you take, and expires on <b>${expiry} IST</b>.</p>

      <p style="margin:20px 0">
        <a href="${esc(p.url)}" style="background:#0f2540;color:#fff;text-decoration:none;
          padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Start the collection</a>
      </p>

      <p style="color:#64748b;font-size:12px">If the button doesn't work, paste this link into your phone's browser:<br>${esc(p.url)}</p>
      <p style="color:#94a3b8;font-size:12px">
        This link is for the assigned agent only. Location access is required to submit.
        If you are told the collection has been cancelled, do not collect the battery.
      </p>
    </div>`;

  const info = await transporter.sendMail({ from, to: p.toEmail, subject, html });
  return { ok: true, messageId: info.messageId };
}
