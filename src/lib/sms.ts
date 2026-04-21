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
  const provider = resolveProvider();
  return provider === "decentro" ? sendDecentroSms(p) : sendGupshupSms(p);
}

export type { SendSmsParams, SendSmsResult };
