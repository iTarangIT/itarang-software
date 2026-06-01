/**
 * Passive VKYC capture-link dispatch — Addendum V0.3.1 §11.
 *
 * Routes the single-use video-KYC link to the CUSTOMER over Email / SMS /
 * WhatsApp. The operator picks the channel explicitly; we honour it and surface
 * a clear error if the matching contact is missing (no silent fallback — they
 * asked for that wire). SMS and WhatsApp both go through the shared Gupshup
 * picker (`sendKycSms`); the chosen wire is passed through per-call.
 *
 * Mirrors src/lib/nbfc/fi-dispatch.ts. Never throws — failures are returned as
 * { ok:false } so the operator sees a clear error instead of a 500.
 */
import { sendVkycLinkEmail } from "@/lib/email/sendVkycLinkEmail";
import { sendKycSms } from "@/lib/sms";

export type VkycChannel = "email" | "sms" | "whatsapp";

export interface DispatchVkycLinkInput {
  channel: VkycChannel;
  email: string | null;
  phone: string | null;
  url: string;
  customerName: string;
  expiresAt: Date;
}

export interface DispatchVkycResult {
  ok: boolean;
  channel: VkycChannel;
  error?: string;
}

export async function dispatchVkycLink(input: DispatchVkycLinkInput): Promise<DispatchVkycResult> {
  const { channel, url, customerName, expiresAt } = input;
  const email = input.email?.trim() || "";
  const phone = input.phone?.trim() || "";

  if (channel === "email" && !email) {
    return { ok: false, channel, error: "The customer has no email on file. Add one, or pick SMS / WhatsApp." };
  }
  if ((channel === "sms" || channel === "whatsapp") && !phone) {
    return { ok: false, channel, error: "The customer has no phone on file. Add one, or pick Email." };
  }

  try {
    if (channel === "email") {
      await sendVkycLinkEmail({ toEmail: email, customerName, url, expiresAt });
      return { ok: true, channel };
    }
    // SMS / WhatsApp — pass the chosen wire through to Gupshup.
    const msg = `iTarang: complete your video verification for your loan application. Open on a device with a camera (expires ${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST): ${url}`;
    const res = await sendKycSms({ mobile_number: phone, message: msg, channel, templateParams: [url] });
    // A SKIPPED send means the provider is disabled/unconfigured — the customer
    // received nothing, so it must NOT be reported as success.
    if (!res.success) {
      const reason = res.skipped
        ? `${channel === "whatsapp" ? "WhatsApp" : "SMS"} provider is not enabled/configured (${res.error ?? "disabled"}). Configure it, or use Email / Copy link.`
        : res.error ?? `${channel} dispatch failed`;
      return { ok: false, channel, error: reason };
    }
    return { ok: true, channel };
  } catch (e) {
    return { ok: false, channel, error: e instanceof Error ? e.message : String(e) };
  }
}
