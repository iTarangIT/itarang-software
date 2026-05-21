import nodemailer from "nodemailer";

export type NbfcWelcomeEmailPayload = {
  toEmail: string;
  primaryContactName: string;
  nbfcLegalName: string;
  nbfcCode: string;
  loginEmail: string;
  password: string;
  loginUrl: string;
  supportEmail: string;
  supportPhone: string;
  signedAgreementPdf?: Buffer | null;
  auditTrailPdf?: Buffer | null;
};

let transporterVerified = false;

async function getMailer() {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !portRaw || !user || !pass) {
    throw new Error(
      `Missing SMTP configuration in environment variables (host=${Boolean(host)}, port=${Boolean(portRaw)}, user=${Boolean(user)}, pass=${Boolean(pass)})`
    );
  }

  const port = Number(portRaw);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  if (!transporterVerified) {
    await transporter.verify();
    transporterVerified = true;
    console.log("[NBFC-WELCOME-MAIL] SMTP connection verified", { host, port, user });
  }

  return transporter;
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

function escapeUrl(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendNbfcWelcomeEmail(payload: NbfcWelcomeEmailPayload) {
  const transporter = await getMailer();

  const hasSignedAgreement = Boolean(
    payload.signedAgreementPdf && payload.signedAgreementPdf.length > 0
  );
  const hasAuditTrail = Boolean(
    payload.auditTrailPdf && payload.auditTrailPdf.length > 0
  );

  const attachmentItems: string[] = [];
  if (hasSignedAgreement) {
    attachmentItems.push(`<li>Signed LSP Agreement (attached as PDF)</li>`);
  }
  if (hasAuditTrail) {
    attachmentItems.push(`<li>Agreement Audit Trail (attached as PDF)</li>`);
  }

  const subject = `Welcome to iTarang NBFC Partner Portal — ${payload.nbfcLegalName}`;

  const html = `
<div style="font-family: Arial, sans-serif; background-color: #f6f8fb; padding: 20px;">
  <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 8px; padding: 25px; border: 1px solid #e0e0e0;">
    <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #eee; margin-bottom: 20px;">
      <img src="https://sandbox.itarang.com/itarang-logo.png" alt="iTarang" style="max-width: 180px; height: auto; display: inline-block;" />
    </div>

    <h2 style="color: #2c3e50; margin-bottom: 10px;">Welcome to the iTarang NBFC Partner Portal</h2>

    <p style="font-size: 15px; color: #333;">Dear <strong>${escapeHtml(payload.primaryContactName)}</strong>,</p>
    <p style="font-size: 15px; color: #333;">Your NBFC partnership with <strong>iTarang</strong> has been activated. We are excited to welcome <strong>${escapeHtml(payload.nbfcLegalName)}</strong> as an authorised lending partner in the iTarang EV ecosystem.</p>
    <p style="font-size: 15px; color: #333;">You can now access the NBFC Partner Portal to manage your portfolio, monitor telemetry, and run recovery & risk workflows.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">🔐 NBFC Partner Account Details</h3>
    <table style="width: 100%; font-size: 14px; color: #333;">
      <tbody>
        <tr>
          <td style="padding: 5px 0;"><strong>Login URL:</strong></td>
          <td><a style="color: #1a73e8;" href="${escapeUrl(payload.loginUrl)}">${escapeHtml(payload.loginUrl)}</a></td>
        </tr>
        <tr>
          <td style="padding: 5px 0;"><strong>Login ID:</strong></td>
          <td>${escapeHtml(payload.loginEmail)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0;"><strong>Temporary Password:</strong></td>
          <td>${escapeHtml(payload.password)}</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size: 14px; margin-top: 10px; color: #555;">⚠️ For security purposes, you will be asked to <strong>change your password upon your first login</strong>.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📌 What You Can Do Next</h3>
    <ul style="font-size: 14px; color: #333; padding-left: 20px;">
      <li>View your portfolio summary and battery health</li>
      <li>Monitor risk signals and recovery queues</li>
      <li>Manage NBFC settings and team access</li>
    </ul>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📎 Important Documents</h3>
    <p style="font-size: 14px; color: #333;">Please find the following documents attached for your reference:</p>
    <ol style="font-size: 14px; color: #333; padding-left: 20px;">
      ${attachmentItems.join("\n      ")}
    </ol>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📞 Need Help?</h3>
    <p style="font-size: 14px; color: #333;">Email: <a href="mailto:${escapeUrl(payload.supportEmail)}">${escapeHtml(payload.supportEmail)}</a><br>Phone: ${escapeHtml(payload.supportPhone)}</p>

    <p style="font-size: 14px; color: #333; margin-top: 20px;">Once again, welcome to the iTarang NBFC Partner Network.<br>We look forward to building a successful partnership with you.</p>
    <p style="font-size: 14px; color: #333;">Warm regards,<br><strong>iTarang Partner Success Team</strong><br>iTarang EV Technologies Pvt Ltd<br><a style="color: #1a73e8;" href="https://www.itarang.com">www.itarang.com</a></p>
  </div>
</div>
`;

  const attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }> = [];

  if (hasSignedAgreement && payload.signedAgreementPdf) {
    attachments.push({
      filename: `signed-lsp-agreement-${payload.nbfcCode}.pdf`,
      content: payload.signedAgreementPdf,
      contentType: "application/pdf",
    });
  }

  if (hasAuditTrail && payload.auditTrailPdf) {
    attachments.push({
      filename: `audit-trail-${payload.nbfcCode}.pdf`,
      content: payload.auditTrailPdf,
      contentType: "application/pdf",
    });
  }

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: payload.toEmail,
    subject,
    html,
    attachments: attachments.length ? attachments : undefined,
  });

  if (info.rejected && info.rejected.length > 0) {
    throw new Error(
      `SMTP server rejected recipients: ${info.rejected.join(", ")} (response: ${info.response})`
    );
  }

  console.log("NBFC WELCOME EMAIL SENT:", {
    messageId: info.messageId,
    to: payload.toEmail,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
    nbfcCode: payload.nbfcCode,
    attached: {
      signedAgreement: hasSignedAgreement,
      auditTrail: hasAuditTrail,
    },
  });

  return {
    ok: true,
    messageId: info.messageId,
    attachedSignedAgreement: hasSignedAgreement,
    attachedAuditTrail: hasAuditTrail,
  };
}
