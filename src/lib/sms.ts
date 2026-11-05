// Provider picker for KYC SMS. Reads SMS_PROVIDER env to decide between
// Gupshup (current default — trial-mode, no DLT) and Decentro (legacy).
// All call sites (DigiLocker initiate + resend-SMS) should go through this
// so switching providers is a one-env-var change.

import { sendDecentroSms } from "./decentro";
import { sendGupshupSms } from "./gupshup";
import type { SendSmsParams, SendSmsResult } from "./sms-types";

export type SmsProvider = "gupshup" | "decentro";

function resolveProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER || "gupshup").toLowerCase();
  return raw === "decentro" ? "decentro" : "gupshup";
}

export async function sendKycSms(p: SendSmsParams): Promise<SendSmsResult> {
  // ID 220 / ID 125: a scheduled job (the daily dispatched → delivered run) on a
  // site that is not the live CRM must not text real customers. Sends a person
  // makes (DigiLocker initiate, resend) are outside any job and go as before.
  const { suppressJobSend } = await import("./runtime/liveSite");
  if (suppressJobSend("sms")) {
    return { success: false, skipped: true, messageId: null, error: "not_live_site", raw: null };
  }
  const provider = resolveProvider();
  return provider === "decentro" ? sendDecentroSms(p) : sendGupshupSms(p);
}

export type { SendSmsParams, SendSmsResult };
