/**
 * E-262 — "do not collect".
 *
 * The counterpart to sendRecoveryAgentLinkEmail, and the more important of the
 * two. An agent who has already set off is about to knock on somebody's door
 * and ask for their battery; if the borrower has since cleared their arrears,
 * that visit is at best embarrassing and at worst a complaint to the RBI
 * ombudsman.
 *
 * So the subject line says it, the first line says it, and there is no button
 * to click — there is nothing left to do. The reason is included because
 * "cancelled" without a why invites a phone call to the NBFC, and when the
 * cause is a payment, saying so is what stops the agent going anyway.
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

export type RecoveryCancelSource = "manual" | "emi_payment" | "reassigned";

export interface RecoveryCancelledEmailPayload {
  toEmail: string;
  agentName: string;
  borrowerName: string;
  city?: string | null;
  batterySerial?: string | null;
  source: RecoveryCancelSource;
  reason?: string | null;
  nbfcName?: string | null;
}

/** One sentence per cause, in the agent's terms rather than the system's. */
function headline(source: RecoveryCancelSource): string {
  switch (source) {
    case "emi_payment":
      return "The borrower has paid, so this battery must NOT be collected.";
    case "reassigned":
      return "This collection has been passed to another agent. Please do not go.";
    default:
      return "This collection has been cancelled. Please do not collect the battery.";
  }
}

export async function sendRecoveryCancelledEmail(
  p: RecoveryCancelledEmailPayload,
): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `iTarang — CANCELLED: do not collect${p.city ? ` (${p.city})` : ""}`;

  const row = (label: string, value: string | null | undefined) =>
    value
      ? `<tr>
           <td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;white-space:nowrap">${esc(label)}</td>
           <td style="padding:4px 0;font-size:13px;font-weight:600">${esc(value)}</td>
         </tr>`
      : "";

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Hello ${esc(p.agentName)},</p>

      <p style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px 16px;
        margin:16px 0;font-weight:600;color:#991b1b">
        ${esc(headline(p.source))}
      </p>

      <table style="border-collapse:collapse;margin:16px 0">
        ${row("Borrower", p.borrowerName)}
        ${row("Battery serial", p.batterySerial)}
        ${row("City", p.city)}
        ${row("Reason", p.reason)}
      </table>

      <p>Your collection link no longer works. There is nothing further to do${
        p.nbfcName ? ` for ${esc(p.nbfcName)}` : ""
      } on this job.</p>

      <p style="color:#94a3b8;font-size:12px">
        If you have already collected this battery, contact the NBFC immediately
        rather than returning it to the borrower.
      </p>
    </div>`;

  const info = await transporter.sendMail({ from, to: p.toEmail, subject, html });
  return { ok: true, messageId: info.messageId };
}
