import nodemailer from "nodemailer";

// Reminder email to a dealer-agreement signer who hasn't signed yet, sent in the
// final days before the agreement expires. Mirrors the SMTP transport used by
// the other dealer emails (sendDealerWelcomeEmail.ts).

export type AgreementExpiryReminderPayload = {
  toEmail: string;
  signerName: string;
  signerRole: string; // e.g. "dealer", "itarang_signatory_1"
  companyName: string;
  daysLeft: number;
  signUrl?: string | null;
  supportEmail: string;
  supportPhone: string;
};

function getMailer() {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !portRaw || !user || !pass) {
    throw new Error("Missing SMTP configuration (SMTP_HOST/PORT/USER/PASS)");
  }
  const port = Number(portRaw);
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendDealerAgreementExpiryReminderEmail(
  payload: AgreementExpiryReminderPayload,
): Promise<{ ok: boolean; messageId?: string }> {
  const transporter = getMailer();

  const dayWord = payload.daysLeft <= 0 ? "today" : `in ${payload.daysLeft} day${payload.daysLeft > 1 ? "s" : ""}`;
  const subject = `Reminder: sign your iTarang dealer agreement — expires ${dayWord}`;

  const cta = payload.signUrl
    ? `<p style="margin:20px 0">
         <a href="${escapeHtml(payload.signUrl)}"
            style="background:#2563eb;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">
           Sign the agreement
         </a>
       </p>
       <p style="font-size:12px;color:#64748b;word-break:break-all">${escapeHtml(payload.signUrl)}</p>`
    : `<p style="font-size:13px;color:#64748b">Please use the secure signing link from your earlier iTarang email/WhatsApp.</p>`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a">
    <h2 style="color:#b45309">Action needed: your agreement expires ${dayWord}</h2>
    <p>Hi ${escapeHtml(payload.signerName || "there")},</p>
    <p>Your signature on the iTarang dealer agreement for
       <strong>${escapeHtml(payload.companyName)}</strong> is still pending. The agreement will
       <strong>expire ${dayWord}</strong>. Please sign it before then to avoid having to restart the process.</p>
    ${cta}
    <p style="font-size:13px;color:#64748b">Need help? Email ${escapeHtml(payload.supportEmail)} or call ${escapeHtml(payload.supportPhone)}.</p>
  </div>`;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: payload.toEmail,
    subject,
    html,
  });

  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`SMTP rejected: ${info.rejected.join(", ")}`);
  }
  return { ok: true, messageId: info.messageId };
}
