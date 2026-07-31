/**
 * The credentials email a scrap vendor gets when an admin onboards them
 * (E-222). Structural twin of sendNbfcWelcomeEmail — same mailer, same
 * escaping, same plaintext-password-in-the-body compromise (there is no vendor
 * portal invite-link flow to hand them instead) and the same hard rule that a
 * rejected recipient THROWS rather than being logged and swallowed: the caller
 * leaves the vendor PENDING when this fails, and a silent success would strand
 * them ACTIVE with no way in.
 *
 * Says out loud that the password is temporary, because the vendor's `users`
 * row is written with must_change_password = true and they WILL be stopped by
 * the change-password modal on first sign-in. A vendor who does not expect that
 * concludes their credentials were wrong.
 */

import { getMailer } from "./mailer";

export type VendorWelcomeEmailPayload = {
  toEmail: string;
  contactName: string;
  vendorName: string;
  /** accounts.id, e.g. VND-20260731-a1b2c3d4 — what support will ask for. */
  vendorCode: string;
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

export async function sendVendorWelcomeEmail(payload: VendorWelcomeEmailPayload) {
  const transporter = await getMailer();

  const subject = `Your iTarang vendor portal login — ${payload.vendorName}`;

  const html = `
<div style="font-family: Arial, sans-serif; background-color: #f6f8fb; padding: 20px;">
  <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 8px; padding: 25px; border: 1px solid #e0e0e0;">
    <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #eee; margin-bottom: 20px;">
      <img src="https://sandbox.itarang.com/itarang-logo.png" alt="iTarang" style="max-width: 180px; height: auto; display: inline-block;" />
    </div>

    <h2 style="color: #2c3e50; margin-bottom: 10px;">Welcome to the iTarang Vendor Portal</h2>

    <p style="font-size: 15px; color: #333;">Dear <strong>${escapeHtml(payload.contactName)}</strong>,</p>
    <p style="font-size: 15px; color: #333;"><strong>${escapeHtml(payload.vendorName)}</strong> has been onboarded as a scrap vendor with <strong>iTarang</strong>. We can now send you end-of-life battery lots as they come up.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">🔐 Your Portal Account</h3>
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
        <tr>
          <td style="padding: 5px 0;"><strong>Vendor Code:</strong></td>
          <td>${escapeHtml(payload.vendorCode)}</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size: 14px; margin-top: 10px; color: #555;">⚠️ For security purposes, you will be asked to <strong>change your password upon your first login</strong>.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📌 What You Can Do Next</h3>
    <ul style="font-size: 14px; color: #333; padding-left: 20px;">
      <li>See the battery lots quoted to you, with photos and per-SKU asks</li>
      <li>Counter a price or accept a lot outright</li>
      <li>Raise your purchase order and track payments</li>
    </ul>
    <p style="font-size: 14px; color: #333;">Your dashboard will stay empty until the first lot is sent to you — that is normal, not a fault.</p>

    <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">

    <h3 style="color: #2c3e50;">📞 Need Help?</h3>
    <p style="font-size: 14px; color: #333;">Email: <a href="mailto:${escapeUrl(payload.supportEmail)}">${escapeHtml(payload.supportEmail)}</a><br>Phone: ${escapeHtml(payload.supportPhone)}</p>

    <p style="font-size: 14px; color: #333; margin-top: 20px;">Welcome aboard.<br><strong>iTarang Partner Success Team</strong><br>iTarang EV Technologies Pvt Ltd<br><a style="color: #1a73e8;" href="https://www.itarang.com">www.itarang.com</a></p>
  </div>
</div>
`;

  const info = await transporter.sendMail({
    // AgentMail ignores `from` (it sends from the inbox itself); nodemailer
    // needs it. Passed either way so the fallback transport works.
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: payload.toEmail,
    subject,
    html,
  });

  if (info.rejected && info.rejected.length > 0) {
    throw new Error(
      `Mail server rejected recipients: ${info.rejected.join(", ")} (response: ${info.response})`,
    );
  }

  // Never the password.
  console.log("VENDOR WELCOME EMAIL SENT:", {
    messageId: info.messageId,
    to: payload.toEmail,
    accepted: info.accepted,
    rejected: info.rejected,
    vendorCode: payload.vendorCode,
  });

  return { ok: true, messageId: info.messageId };
}
