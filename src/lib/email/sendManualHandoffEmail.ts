/**
 * Manual Handoff (Model M2) emails — BRD Addendum V0.2 §11.7.
 *
 *  sendManualHandoffEmail   — one email PER off-platform NBFC, each carrying the
 *                              customer KYC document (a separate copy each).
 *  sendManualHandoffNudge   — the 24-hour recurring reminder to the admin to
 *                              chase the off-platform NBFC(s) (MH-4).
 *
 * Uses the shared mailer transport (see mailer.ts).
 */
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ManualHandoffEmailPayload {
  toEmails: string[];
  leadId: string;
  customerName: string;
  customerPhone?: string | null;
  loanAmount?: string | number | null;
  /** Optional customer KYC document, attached to every recipient's copy. */
  kycPdf?: Buffer | null;
  kycPdfFilename?: string;
}

export async function sendManualHandoffEmail(p: ManualHandoffEmailPayload): Promise<{ ok: boolean; sent: number; messageIds: string[] }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `iTarang — Loan financing request for ${p.customerName} (Lead ${p.leadId})`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Dear Partner,</p>
      <p>A customer financing request is being shared with you for evaluation on your own systems.</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Lead ID</td><td><b>${esc(p.leadId)}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Customer</td><td>${esc(p.customerName)}</td></tr>
        ${p.customerPhone ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Phone</td><td>${esc(p.customerPhone)}</td></tr>` : ""}
        ${p.loanAmount != null ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Indicative amount</td><td>₹${esc(p.loanAmount)}</td></tr>` : ""}
      </table>
      <p>The customer KYC document is attached. Please verify and sanction on your systems; reply with your decision so we can record the outcome.</p>
      <p style="color:#94a3b8;font-size:12px">iTarang facilitates and files but is not a party to the loan agreement.</p>
    </div>`;

  const attachments = p.kycPdf
    ? [{ filename: p.kycPdfFilename || `KYC-${p.leadId}.pdf`, content: p.kycPdf, contentType: "application/pdf" }]
    : undefined;

  const messageIds: string[] = [];
  // Each NBFC gets its own separate email (§11.7).
  for (const to of p.toEmails) {
    const info = await transporter.sendMail({ from, to, subject, html, attachments });
    messageIds.push(info.messageId);
  }
  return { ok: true, sent: messageIds.length, messageIds };
}

/**
 * §6.1 — notify a losing NBFC's step-owner that the customer picked another
 * lender. One email per recipient; best-effort (callers wrap in try/catch).
 */
export async function sendNotSelectedEmail(p: {
  toEmails: string[];
  leadId: string;
  nbfcName: string;
  customerName: string;
}): Promise<{ ok: boolean; sent: number }> {
  const recipients = p.toEmails.filter((e) => !!e);
  if (recipients.length === 0) return { ok: true, sent: 0 };
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `iTarang — Lead ${p.leadId} selected another lender`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Dear ${esc(p.nbfcName)} team,</p>
      <p>The customer for <b>${esc(p.leadId)}</b> (${esc(p.customerName)}) has selected a different
      financing partner. This lead is now marked <b>Not Selected</b> for your NBFC in the Acquire
      pipeline. No further action is needed.</p>
      <p style="color:#94a3b8;font-size:12px">Competitive routing — Field Investigation and Video KYC
      run at the NBFC's own cost; no per-service refund applies.</p>
    </div>`;
  let sent = 0;
  for (const to of recipients) {
    await transporter.sendMail({ from, to, subject, html });
    sent += 1;
  }
  return { ok: true, sent };
}

export async function sendManualHandoffNudge(p: {
  toEmail: string;
  leadId: string;
  customerName: string;
  sentToEmails: string[];
  nudgeCount: number;
}): Promise<{ ok: boolean; messageId: string }> {
  const transporter = await getMailer();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>Reminder #${p.nudgeCount + 1}: a manual handoff is awaiting an outcome.</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Lead</td><td><b>${esc(p.leadId)}</b> — ${esc(p.customerName)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Sent to</td><td>${esc(p.sentToEmails.join(", "))}</td></tr>
      </table>
      <p>Please chase the off-platform NBFC(s) and record an outcome (accepted / declined), or mark the handoff exhausted.</p>
    </div>`;
  const info = await transporter.sendMail({
    from,
    to: p.toEmail,
    subject: `[Action] Manual handoff awaiting outcome — Lead ${p.leadId}`,
    html,
  });
  return { ok: true, messageId: info.messageId };
}
