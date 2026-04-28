import nodemailer from "nodemailer";

export type DealerCorrectionNotificationPayload = {
  toEmails: string[];
  companyName: string;
  applicationId: string;
  correctionRemarks: string;
  correctionLink?: string;
  requestedFieldLabels?: string[];
  requestedDocumentLabels?: string[];
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
    auth: {
      user,
      pass,
    },
  });
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderItemList(items: string[]) {
  if (!items.length) return "";
  return `
    <ul style="margin: 8px 0 0; padding-left: 20px; color: #0f172a;">
      ${items.map((item) => `<li style="margin-bottom: 4px;">${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

export async function sendDealerCorrectionNotificationEmail(
  payload: DealerCorrectionNotificationPayload
) {
  const recipients = sanitizeEmails(payload.toEmails);

  if (!recipients.length) {
    throw new Error("No correction notification recipients provided");
  }

  const transporter = getMailer();

  const subject = `Action Required — Correct your dealer onboarding application ${payload.applicationId}`;

  const fieldLabels = payload.requestedFieldLabels ?? [];
  const documentLabels = payload.requestedDocumentLabels ?? [];

  const ctaBlock = payload.correctionLink
    ? `
        <div style="margin-top: 20px; text-align: center;">
          <a
            href="${escapeHtml(payload.correctionLink)}"
            style="display: inline-block; padding: 14px 28px; background: #173F63; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 999px; font-size: 14px; letter-spacing: 0.2px;"
          >
            Open correction form
          </a>
          <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">
            This secure link is valid for 14 days. No login required.
          </p>
        </div>
      `
    : "";

  const fieldsBlock = fieldLabels.length
    ? `
        <div style="margin-top: 16px; padding: 16px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
          <p style="margin: 0; font-weight: 600; color: #173F63;">Information to update</p>
          ${renderItemList(fieldLabels)}
        </div>
      `
    : "";

  const documentsBlock = documentLabels.length
    ? `
        <div style="margin-top: 12px; padding: 16px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
          <p style="margin: 0; font-weight: 600; color: #173F63;">Documents to re-upload</p>
          ${renderItemList(documentLabels)}
        </div>
      `
    : "";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6; max-width: 640px; margin: 0 auto;">
      <div style="padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
        <h2 style="margin: 0 0 12px; color: #173F63;">Action Required — Correct your application</h2>

        <p style="margin: 0 0 12px;">
          Your dealer onboarding application has been reviewed. A few items
          need to be corrected before we can proceed with approval.
        </p>

        <div style="margin-top: 16px; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
          <p style="margin: 0 0 8px;"><strong>Dealer / Company:</strong> ${escapeHtml(payload.companyName)}</p>
          <p style="margin: 0 0 8px;"><strong>Application ID:</strong> ${escapeHtml(payload.applicationId)}</p>
          <p style="margin: 0;"><strong>Status:</strong> Correction Requested</p>
        </div>

        <div style="margin-top: 16px; padding: 16px; background: #fff7ed; border: 1px solid #fdba74; border-radius: 12px;">
          <p style="margin: 0 0 8px;"><strong>Reviewer remarks</strong></p>
          <p style="margin: 0; white-space: pre-line;">${escapeHtml(payload.correctionRemarks)}</p>
        </div>

        ${fieldsBlock}
        ${documentsBlock}
        ${ctaBlock}

        <p style="margin-top: 20px; font-size: 13px; color: #475569;">
          If the button above doesn't work, copy and paste this link into your browser:<br/>
          <span style="word-break: break-all; color: #1F5C8F;">${payload.correctionLink ? escapeHtml(payload.correctionLink) : ""}</span>
        </p>

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

  console.log("DEALER CORRECTION NOTIFICATION EMAIL SENT:", {
    messageId: info.messageId,
    recipients,
    applicationId: payload.applicationId,
    fieldsCount: fieldLabels.length,
    documentsCount: documentLabels.length,
    hasLink: Boolean(payload.correctionLink),
  });

  return {
    ok: true,
    messageId: info.messageId,
    recipients,
  };
}
