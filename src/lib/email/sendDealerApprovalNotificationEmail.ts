import nodemailer from "nodemailer";

export type DealerApprovalNotificationPayload = {
  toEmails: string[];
  companyName: string;
  dealerCode: string;
  dealerName: string;
  approvedAt: string;
};

function getMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP configuration in environment variables");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function escapeHtml(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

function sanitizeEmails(emails: string[]) {
  return Array.from(
    new Set(
      emails
        .map((email) => (typeof email === "string" ? email.trim().toLowerCase() : ""))
        .filter(Boolean)
    )
  );
}

export async function sendDealerApprovalNotificationEmail(
  payload: DealerApprovalNotificationPayload
) {
  const recipients = sanitizeEmails(payload.toEmails);

  if (!recipients.length) {
    throw new Error("No approval notification recipients provided");
  }

  const transporter = getMailer();
  const approvedAtLabel = new Date(payload.approvedAt).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const subject = `Dealer Onboarding Approved — ${payload.companyName} (${payload.dealerCode})`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6; max-width: 640px; margin: 0 auto;">
      <div style="padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
        <h2 style="margin: 0 0 12px; color: #065f46;">Dealer Onboarding Approved</h2>

        <p style="margin: 0 0 12px;">
          A dealer onboarding application has been approved after admin review. The dealer has been notified separately with login credentials.
        </p>

        <div style="margin-top: 16px; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
          <p style="margin: 0 0 8px;"><strong>Dealer / Company:</strong> ${escapeHtml(payload.companyName)}</p>
          <p style="margin: 0 0 8px;"><strong>Primary Contact:</strong> ${escapeHtml(payload.dealerName)}</p>
          <p style="margin: 0 0 8px;"><strong>Dealer Code:</strong> ${escapeHtml(payload.dealerCode)}</p>
          <p style="margin: 0 0 8px;"><strong>Approved At:</strong> ${escapeHtml(approvedAtLabel)} IST</p>
          <p style="margin: 0;"><strong>Status:</strong> Approved &amp; Active</p>
        </div>

        <div style="margin-top: 16px; padding: 16px; background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 12px;">
          <p style="margin: 0;">The dealer account is now active. No further action is required from you.</p>
        </div>

        <p style="margin-top: 24px; margin-bottom: 0;">
          Regards,<br/>
          iTarang Compliance Team
        </p>
      </div>
    </div>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recipients.join(","),
    subject,
    html,
  });

  console.log("DEALER APPROVAL NOTIFICATION EMAIL SENT:", {
    messageId: info.messageId,
    recipients,
    dealerCode: payload.dealerCode,
  });

  return {
    ok: true,
    messageId: info.messageId,
    recipients,
  };
}
