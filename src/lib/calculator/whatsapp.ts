// WhatsApp delivery for the dealer Loan Calculator OTP gate + results summary.
//
// Both sends are business-initiated (the customer has usually never messaged
// us), so in production they need pre-approved Meta templates, configured via
// env. When the template env vars are unset we fall back to free-form
// sendText — which only works inside a 24h customer-initiated session (dev /
// test numbers). Mirrors the fallback precedent in
// src/app/api/inside-sales/lead/[id]/whatsapp-onboarding/route.ts.
//
// Env (all optional):
//   CALC_OTP_WA_TEMPLATE / CALC_OTP_WA_TEMPLATE_LANG         — OTP template, one body param (the code)
//   CALC_RESULTS_WA_TEMPLATE / CALC_RESULTS_WA_TEMPLATE_LANG — results template, body params
//     [customerName, modelName, schemesSingleLine] (Meta bans newlines in body params)

import { getAdapter } from "@/lib/whatsapp";
import { logOutbound } from "@/lib/whatsapp/notifications";
import type { SendResult } from "@/lib/whatsapp/types";

/**
 * Single phone normalization shared by send-otp / verify-otp / calculate so the
 * OTP row always matches regardless of "+91 98765-43210" / "09876543210" input.
 * Returns "91XXXXXXXXXX" or null when not a valid Indian mobile.
 */
export function normalizeCalcPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null;
}

export function maskCalcPhone(normalized: string): string {
  return `XXXXXX${normalized.slice(-4)}`;
}

export function metaWhatsAppConfigured(): boolean {
  return !!(
    process.env.META_WA_ACCESS_TOKEN?.trim() &&
    process.env.META_WA_PHONE_NUMBER_ID?.trim()
  );
}

/** Send the calculator OTP to the customer's WhatsApp. Caller surfaces failure. */
export async function sendCalcOtpWhatsApp(
  phone: string,
  otp: string,
  customerName: string,
): Promise<SendResult> {
  const adapter = getAdapter();
  const template = process.env.CALC_OTP_WA_TEMPLATE?.trim();

  let res: SendResult;
  if (template) {
    res = await adapter.sendTemplate(
      phone,
      template,
      process.env.CALC_OTP_WA_TEMPLATE_LANG?.trim() || "en",
      [otp],
    );
    await logOutbound(null, res, {
      messageType: "template",
      templateName: template,
      textBody: `template:${template} (calculator OTP for ${customerName})`,
    });
  } else {
    const body =
      `Hi ${customerName}, your iTarang verification code is *${otp}*.\n\n` +
      `It is valid for 10 minutes. Please share it only with your iTarang dealer.`;
    res = await adapter.sendText(phone, body);
    await logOutbound(null, res, { messageType: "text", textBody: body });
  }
  return res;
}

// Minimal shape of the engine result the summary needs (avoids importing the
// engine's full CalcResult type into this delivery module).
interface SchemeForSummary {
  nbfc: string;
  schemeCode: string;
  tenure: number;
  emi: number;
  totalUpfront: number;
  estimatedTotalPayable: number;
  recommended?: boolean;
}
export interface CalcResultForSummary {
  outcome: "qualified" | "stretch_only" | "none";
  qualified: SchemeForSummary[];
  stretch: SchemeForSummary[];
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Send the scheme results summary to the customer's WhatsApp. Best-effort:
 * never throws; "skipped" when the provider isn't configured.
 */
export async function sendCalcResultsWhatsApp(
  phone: string,
  customerName: string,
  result: CalcResultForSummary,
  modelName: string,
): Promise<"sent" | "failed" | "skipped"> {
  try {
    if (!metaWhatsAppConfigured()) return "skipped";

    const adapter = getAdapter();
    const template = process.env.CALC_RESULTS_WA_TEMPLATE?.trim();
    const schemes = (result.qualified.length > 0 ? result.qualified : result.stretch).slice(0, 3);

    let res: SendResult;
    if (template) {
      // Meta bans newlines in body params — schemes joined on one line.
      const line =
        schemes.length > 0
          ? schemes
              .map(
                (s) =>
                  `${s.nbfc} ${s.schemeCode}: EMI ${inr(s.emi)}/m x ${s.tenure}m, pay today ${inr(s.totalUpfront)}`,
              )
              .join("; ")
          : "No schemes matched your filters - please contact your dealer";
      res = await adapter.sendTemplate(
        phone,
        template,
        process.env.CALC_RESULTS_WA_TEMPLATE_LANG?.trim() || "en",
        [customerName, modelName, line],
      );
      await logOutbound(null, res, {
        messageType: "template",
        templateName: template,
        textBody: `template:${template} (calculator results for ${customerName})`,
      });
    } else {
      const lines = schemes.map(
        (s) =>
          `${s.recommended ? "⭐ " : ""}*${s.nbfc}* (${s.schemeCode})\n` +
          `   EMI ${inr(s.emi)}/month × ${s.tenure} months\n` +
          `   Total payable today: ${inr(s.totalUpfront)}`,
      );
      const heading =
        result.qualified.length > 0
          ? "here are the EMI schemes you qualify for"
          : result.stretch.length > 0
            ? "here are the schemes closest to your budget"
            : "no schemes matched your filters right now";
      const body =
        `Hi ${customerName}, ${heading} — *${modelName}*:\n\n` +
        (lines.length > 0 ? `${lines.join("\n\n")}\n\n` : "") +
        `Figures are indicative and subject to NBFC approval. ` +
        `Please contact your iTarang dealer to proceed.`;
      res = await adapter.sendText(phone, body);
      await logOutbound(null, res, { messageType: "text", textBody: body });
    }

    return res.ok ? "sent" : "failed";
  } catch (err) {
    console.error("[Calculator/whatsapp] results send threw:", err);
    return "failed";
  }
}
