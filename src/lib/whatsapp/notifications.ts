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
