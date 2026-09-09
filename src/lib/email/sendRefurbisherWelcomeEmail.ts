/**
 * E-292 — the credentials email a refurbishment partner gets when an admin
 * onboards them. Structural twin of sendVendorWelcomeEmail: same mailer, same
 * escaping, same plaintext-temporary-password compromise, and the same rule
 * that a rejected recipient THROWS so the caller can leave the partner in
 * `credential_dispatch_failed` and offer a retry.
 */
import { getMailer } from "./mailer";

export type RefurbisherWelcomeEmailPayload = {
  toEmail: string;
  contactName: string;
  refurbisherName: string;
  loginEmail: string;
  password: string;
  loginUrl: string;
  supportEmail: string;
  supportPhone: string;
};

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

export async function sendRefurbisherWelcomeEmail(payload: RefurbisherWelcomeEmailPayload) {
  const transporter = await getMailer();
  const subject = `Your iTarang refurbisher portal login — ${payload.refurbisherName}`;

  const html = `
<div style="font-family: Arial, sans-serif; background-color: #f6f8fb; padding: 20px;">
  <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 8px; padding: 25px; border: 1px solid #e0e0e0;">
    <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #eee; margin-bottom: 20px;">
      <img src="https://sandbox.itarang.com/itarang-logo.png" alt="iTarang" style="max-width: 180px; height: auto; display: inline-block;" />
    </div>

    <h2 style="color: #2c3e50; margin-bottom: 10px;">Welcome to the iTarang Refurbisher Portal</h2>

    <p style="font-size: 15px; color: #333;">Dear <strong>${escapeHtml(payload.contactName)}</strong>,</p>
    <p style="font-size: 15px; color: #333;"><strong>${escapeHtml(payload.refurbisherName)}</strong> has been onboarded as a battery refurbishment partner with <strong>iTarang</strong>. We will assign you lots of recovered batteries to refurbish as they come in.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">🔐 Your Portal Account</h3>
    <table style="width: 100%; font-size: 14px; color: #333;">
      <tbody>
        <tr><td style="padding: 5px 0;"><strong>Login URL:</strong></td><td><a style="color: #1a73e8;" href="${escapeUrl(payload.loginUrl)}">${escapeHtml(payload.loginUrl)}</a></td></tr>
        <tr><td style="padding: 5px 0;"><strong>Login ID:</strong></td><td>${escapeHtml(payload.loginEmail)}</td></tr>
        <tr><td style="padding: 5px 0;"><strong>Temporary Password:</strong></td><td>${escapeHtml(payload.password)}</td></tr>
      </tbody>
    </table>
    <p style="font-size: 14px; margin-top: 10px; color: #555;">⚠️ For security purposes, you will be asked to <strong>change your password upon your first login</strong>.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📌 What You Can Do</h3>
    <ul style="font-size: 14px; color: #333; padding-left: 20px;">
      <li>See the lots iTarang has assigned to you, battery by battery, with photographs</li>
      <li>Start work, tick the checklist, record parts and your cost per battery</li>
      <li>Record the return dispatch when the batteries leave your workshop</li>
    </ul>
    <p style="font-size: 14px; color: #333;">Your lot list will stay empty until iTarang assigns the first one — that is normal, not a fault.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📞 Need Help?</h3>
    <p style="font-size: 14px; color: #333;">Email: <a href="mailto:${escapeUrl(payload.supportEmail)}">${escapeHtml(payload.supportEmail)}</a><br>Phone: ${escapeHtml(payload.supportPhone)}</p>

    <p style="font-size: 14px; color: #333; margin-top: 20px;">Welcome aboard.<br><strong>iTarang Partner Success Team</strong><br>iTarang EV Technologies Pvt Ltd<br><a style="color: #1a73e8;" href="https://www.itarang.com">www.itarang.com</a></p>
  </div>
</div>
`;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: payload.toEmail,
    subject,
    html,
  });

  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`Mail server rejected recipients: ${info.rejected.join(", ")} (response: ${info.response})`);
  }
  return info;
}
