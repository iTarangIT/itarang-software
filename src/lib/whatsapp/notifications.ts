// Out-of-band WhatsApp notifications for admin review actions (approve / reject).
//
// These are NOT part of the onboarding conversation state machine — they're
// fire-and-forget messages the admin routes send to a WhatsApp-onboarded dealer
// after acting on their application. Every send is best-effort: a failure here
// must never fail the admin action (mirrors the existing email pattern). All
// sends are logged to whatsapp_messages for audit, exactly like the in-chat
// orchestrator's reply() helper.
//
// 24h-window caveat: these use free-form sends, so Meta will reject them if the
// dealer hasn't messaged in the last 24h (the app is an unpublished test app).
// The returned `ok` surfaces that so the caller can report it. Pre-approved
// templates are a later follow-up.

import { db } from "@/lib/db/index";
import { whatsappMessages } from "@/lib/db/schema";

import { getAdapter } from "./index";
import type { SendResult } from "./types";

/** Append an outbound send to whatsapp_messages (best-effort; never throws). */
export async function logOutbound(
  sessionId: string | null,
  res: SendResult,
  opts: {
    messageType: "text" | "document" | "template" | "interactive";
    textBody?: string | null;
    templateName?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(whatsappMessages).values({
      session_id: sessionId,
      provider_message_id: res.providerMessageId,
      direction: "outbound",
      message_type: opts.messageType,
      text_body: opts.textBody ?? null,
      template_name: opts.templateName ?? null,
      delivery_status: res.ok ? "sent" : "failed",
      raw_payload: (res.raw ?? null) as any,
    });
  } catch (err) {
    console.error("[WhatsApp/notifications] logOutbound failed:", err);
  }
}

export type WhatsAppDelivery = {
  attempted: boolean;
  ok: boolean;
  error?: string | null;
};

export type DealerWelcomeWhatsAppParams = {
  waPhone: string;
  waSessionId: string | null;
  dealerName: string;
  companyName: string;
  dealerCode: string;
  loginId: string;
  password: string;
  loginUrl: string;
  supportEmail: string;
  supportPhone: string;
  financeEnabled: boolean;
  signedAgreementUrl?: string | null;
  auditTrailUrl?: string | null;
};

/**
 * Approve → dealer welcome over WhatsApp: credentials as a text message, then
 * the signed agreement + audit trail as PDF document messages (finance dealers).
 * Additive to the welcome email, which is unchanged.
 */
export async function sendDealerWelcomeWhatsApp(
  p: DealerWelcomeWhatsAppParams,
): Promise<WhatsAppDelivery> {
  const adapter = getAdapter();
  const delivery: WhatsAppDelivery = { attempted: true, ok: false, error: null };

  try {
    const body =
      `🎉 *Welcome to iTarang, ${p.dealerName}!*\n\n` +
      `Your dealer account for *${p.companyName}* is now *active*. ` +
      `Here are your login details:\n\n` +
      `🔗 *Portal:* ${p.loginUrl}\n` +
      `🆔 *Login ID:* ${p.loginId}\n` +
      `🔑 *Temporary Password:* ${p.password}\n` +
      `🏷️ *Dealer ID:* ${p.dealerCode}\n\n` +
      `⚠️ Please log in and *change your password* on first use.\n\n` +
      (p.financeEnabled && p.signedAgreementUrl
        ? p.auditTrailUrl
          ? `Your *signed agreement* and *audit trail* are attached below for your records.\n\n`
          : `Your *signed agreement* is attached below for your records.\n\n`
        : "") +
      `Need help? Email ${p.supportEmail} or call ${p.supportPhone}.`;

    const textRes = await adapter.sendText(p.waPhone, body);
    await logOutbound(p.waSessionId, textRes, {
      messageType: "text",
      textBody: body,
    });
    delivery.ok = textRes.ok;
    delivery.error = textRes.error ?? null;

    // Finance dealers also get the two PDFs as document messages.
    if (p.financeEnabled) {
      if (p.signedAgreementUrl) {
        const res = await adapter.sendDocument(
          p.waPhone,
          p.signedAgreementUrl,
          `signed-agreement-${p.dealerCode}.pdf`,
          "Signed Dealer Agreement",
        );
        await logOutbound(p.waSessionId, res, {
          messageType: "document",
          textBody: "Signed Dealer Agreement",
        });
        if (!res.ok) delivery.error = delivery.error || res.error || null;
      }
      if (p.auditTrailUrl) {
        const res = await adapter.sendDocument(
          p.waPhone,
          p.auditTrailUrl,
          `audit-trail-${p.dealerCode}.pdf`,
          "Agreement Audit Trail",
        );
        await logOutbound(p.waSessionId, res, {
          messageType: "document",
          textBody: "Agreement Audit Trail",
        });
        if (!res.ok) delivery.error = delivery.error || res.error || null;
      }
    }
  } catch (err: any) {
    delivery.error = err?.message || "whatsapp_send_error";
    console.error("[WhatsApp/notifications] welcome send threw:", err);
  }

  return delivery;
}

/**
 * E-214 — confirmation copy to the internal operator who onboarded this dealer.
 *
 * SECURITY: this params type deliberately has NO `password` and NO `loginId`
 * field. The operator is told WHERE the credentials went, never what they are —
 * omission enforced by the type, not by discipline at the call site. Do not add
 * those fields; if an operator needs to re-issue access, use the admin console's
 * "Reset & resend credentials", which mints a fresh password for the dealer.
 */
export type OperatorApprovalWhatsAppParams = {
  waPhone: string;
  waSessionId: string | null;
  operatorName: string;
  companyName: string;
  dealerCode: string;
  /** Masked dealer phone, e.g. "••••3210". */
  dealerPhoneMasked: string;
  dealerEmail: string;
  financeEnabled: boolean;
};

export async function sendOperatorApprovalConfirmationWhatsApp(
  p: OperatorApprovalWhatsAppParams,
): Promise<WhatsAppDelivery> {
  const delivery: WhatsAppDelivery = { attempted: true, ok: false, error: null };
  try {
    const body =
      `✅ *${p.companyName}* has been approved.\n\n` +
      `🏷️ *Dealer ID:* ${p.dealerCode}\n` +
      `💳 *Financing:* ${p.financeEnabled ? "enabled" : "cash only"}\n\n` +
      `Login credentials were sent directly to the dealer on WhatsApp ` +
      `(${p.dealerPhoneMasked}) and by email (${p.dealerEmail}).\n` +
      `🔒 For security, the password is not shared with you.\n\n` +
      `Nice work, ${p.operatorName}! Type *menu* to start the next dealer.`;

    const res = await getAdapter().sendText(p.waPhone, body);
    await logOutbound(p.waSessionId, res, {
      messageType: "text",
      textBody: body,
    });
    delivery.ok = res.ok;
    delivery.error = res.error ?? null;
  } catch (err: any) {
    delivery.error = err?.message || "whatsapp_send_error";
    console.error("[WhatsApp/notifications] operator confirmation threw:", err);
  }
  return delivery;
}

/** E-214 — tell the operator their file was declined, instead of silence. */
export async function sendOperatorRejectionWhatsApp(p: {
  waPhone: string;
  waSessionId: string | null;
  operatorName: string;
  companyName: string;
  reason?: string | null;
}): Promise<WhatsAppDelivery> {
  const delivery: WhatsAppDelivery = { attempted: true, ok: false, error: null };
  try {
    const body =
      `❌ *${p.companyName}* was not approved.\n\n` +
      (p.reason ? `*Reason:* ${p.reason}\n\n` : "") +
      `The dealer has been informed. Type *menu* to start another onboarding.`;
    const res = await getAdapter().sendText(p.waPhone, body);
    await logOutbound(p.waSessionId, res, {
      messageType: "text",
      textBody: body,
    });
    delivery.ok = res.ok;
    delivery.error = res.error ?? null;
  } catch (err: any) {
    delivery.error = err?.message || "whatsapp_send_error";
    console.error("[WhatsApp/notifications] operator rejection threw:", err);
  }
  return delivery;
}

/** Last 4 digits only, for telling an operator where credentials landed. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "••••";
}

export type FinanceActivatedWhatsAppParams = {
  waPhone: string;
  waSessionId: string | null;
  dealerName: string;
  companyName: string;
  dealerCode: string;
  supportEmail: string;
  supportPhone: string;
  signedAgreementUrl?: string | null;
  auditTrailUrl?: string | null;
};

/**
 * Post-approval finance activation → dealer notification over WhatsApp.
 *
 * Sent by the activate-finance route once the dealer agreement is signed and
 * `dealers.finance_enabled` flips to true. Unlike the welcome message this
 * carries NO credentials — the dealer is already live and keeps the login they
 * were given at approval. It only tells them the finance option is now
 * available and hands over the signed PDFs for their records.
 */
export async function sendFinanceActivatedWhatsApp(
  p: FinanceActivatedWhatsAppParams,
): Promise<WhatsAppDelivery> {
  const adapter = getAdapter();
  const delivery: WhatsAppDelivery = { attempted: true, ok: false, error: null };

  try {
    const body =
      `✅ *Financing is now enabled, ${p.dealerName}!*\n\n` +
      `Your dealer agreement for *${p.companyName}* is signed, and financing is ` +
      `now active on your account (*${p.dealerCode}*).\n\n` +
      `You can now choose *iTarang Finance* or *Other Finance* as the payment ` +
      `method when you create a new lead here on WhatsApp — just send *hi* and ` +
      `tap *🆕 New Lead*.\n\n` +
      (p.signedAgreementUrl
        ? p.auditTrailUrl
          ? `Your *signed agreement* and *audit trail* are attached below for your records.\n\n`
          : `Your *signed agreement* is attached below for your records.\n\n`
        : "") +
      `Need help? Email ${p.supportEmail} or call ${p.supportPhone}.`;

    const textRes = await adapter.sendText(p.waPhone, body);
    await logOutbound(p.waSessionId, textRes, {
      messageType: "text",
      textBody: body,
    });
    delivery.ok = textRes.ok;
    delivery.error = textRes.error ?? null;

    if (p.signedAgreementUrl) {
      const res = await adapter.sendDocument(
        p.waPhone,
        p.signedAgreementUrl,
        `signed-agreement-${p.dealerCode}.pdf`,
        "Signed Dealer Agreement",
      );
      await logOutbound(p.waSessionId, res, {
        messageType: "document",
        textBody: "Signed Dealer Agreement",
      });
      if (!res.ok) delivery.error = delivery.error || res.error || null;
    }
    if (p.auditTrailUrl) {
      const res = await adapter.sendDocument(
        p.waPhone,
        p.auditTrailUrl,
        `audit-trail-${p.dealerCode}.pdf`,
        "Agreement Audit Trail",
      );
      await logOutbound(p.waSessionId, res, {
        messageType: "document",
        textBody: "Agreement Audit Trail",
      });
      if (!res.ok) delivery.error = delivery.error || res.error || null;
    }
  } catch (err: any) {
    delivery.error = err?.message || "whatsapp_send_error";
    console.error("[WhatsApp/notifications] finance-activated send threw:", err);
  }

  return delivery;
}

export type DealerRejectedWhatsAppParams = {
  waPhone: string;
  waSessionId: string | null;
  dealerName: string;
  companyName: string;
  remarks: string;
  supportEmail: string;
  supportPhone: string;
};

/** Reject → dealer notification over WhatsApp (additive to the rejection email). */
export async function sendDealerRejectedWhatsApp(
  p: DealerRejectedWhatsAppParams,
): Promise<WhatsAppDelivery> {
  const adapter = getAdapter();
  const delivery: WhatsAppDelivery = { attempted: true, ok: false, error: null };

  try {
    const body =
      `Hi ${p.dealerName}, we've reviewed your iTarang dealer application for ` +
      `*${p.companyName}* and unfortunately it was *not approved* at this time.\n\n` +
      `*Reason:* ${p.remarks}\n\n` +
      `If you'd like to discuss this, email ${p.supportEmail} or call ${p.supportPhone}.`;

    const res = await adapter.sendText(p.waPhone, body);
    await logOutbound(p.waSessionId, res, {
      messageType: "text",
      textBody: body,
    });
    delivery.ok = res.ok;
    delivery.error = res.error ?? null;
  } catch (err: any) {
    delivery.error = err?.message || "whatsapp_send_error";
    console.error("[WhatsApp/notifications] rejection send threw:", err);
  }

  return delivery;
}
