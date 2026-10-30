// ─── Exotel SMS API ─────────────────────────────────────────────────────────
// Tracker ID 204 (30 Oct): the EMI customer SMS go out through Exotel, not
// MSG91. Exotel sends the full text; the operator matches it against the
// DLT-registered template (DltTemplateId), so the text must be the DLT text
// with each {#var#} filled in — nothing else may differ.
//
//   POST https://<subdomain>/v1/Accounts/<sid>/Sms/send.json   (basic auth)
//
// Required env:
//   EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN
//   EXOTEL_SUBDOMAIN       — api.exotel.com (Singapore) or api.in.exotel.com (Mumbai)
//   EXOTEL_SMS_SENDER_ID   — the DLT header, e.g. ITARNG
//   EXOTEL_DLT_ENTITY_ID   — the DLT principal entity id
// Optional:
//   EXOTEL_SMS_STATUS_SECRET — when set, each SMS carries a StatusCallback to
//                              /api/webhooks/exotel/sms-status?key=<secret>

import type { SendSmsResult } from "./sms-types";

function env(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/** "api.in.exotel.com" from any of "@api.in.exotel.com", "https://api.in.exotel.com/". */
function apiHost(): string {
  return (env("EXOTEL_SUBDOMAIN") ?? "api.exotel.com").replace(/^https?:\/\//, "").replace(/^@/, "").replace(/\/+$/, "");
}

export function exotelSmsConfigured(): boolean {
  return !!(env("EXOTEL_SID") && env("EXOTEL_API_KEY") && env("EXOTEL_API_TOKEN") && env("EXOTEL_SMS_SENDER_ID"));
}

export async function sendExotelSms(p: {
  /** 10-digit Indian mobile (or with country code — the last 10 digits are used). */
  mobile_number: string;
  /** The full text, exactly the DLT template with its variables filled in. */
  body: string;
  /** DLT template id the text is registered under. */
  dlt_template_id: string;
}): Promise<SendSmsResult> {
  const { suppressJobSend } = await import("./runtime/liveSite");
  if (suppressJobSend("sms")) {
    return { success: false, skipped: true, messageId: null, error: "not_live_site", raw: null };
  }
  if (!exotelSmsConfigured()) {
    return { success: false, skipped: true, messageId: null, error: "exotel_disabled", raw: null };
  }
  if (!p.dlt_template_id?.trim()) {
    return { success: false, skipped: true, messageId: null, error: "no DLT template id", raw: null };
  }
  const digits = p.mobile_number.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return { success: false, messageId: null, error: `invalid_mobile:${p.mobile_number}`, raw: null };
  }

  const form = new URLSearchParams({
    From: env("EXOTEL_SMS_SENDER_ID")!,
    To: `0${digits}`,
    Body: p.body,
    DltTemplateId: p.dlt_template_id.trim(),
    SmsType: "transactional",
    // Hindi (or any non-ASCII) must go as unicode or the operator garbles it.
    EncodingType: /[^\x00-\x7F]/.test(p.body) ? "unicode" : "plain",
  });
  const entity = env("EXOTEL_DLT_ENTITY_ID");
  if (entity) form.set("DltEntityId", entity);
  const secret = env("EXOTEL_SMS_STATUS_SECRET");
  if (secret) {
    const { crmBaseUrl } = await import("./assistant/config");
    form.set("StatusCallback", `${crmBaseUrl()}/api/webhooks/exotel/sms-status?key=${encodeURIComponent(secret)}`);
  }

  const sid = env("EXOTEL_SID")!;
  const auth = Buffer.from(`${env("EXOTEL_API_KEY")}:${env("EXOTEL_API_TOKEN")}`).toString("base64");
  try {
    const res = await fetch(`https://${apiHost()}/v1/Accounts/${encodeURIComponent(sid)}/Sms/send.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    const msg = data?.SMSMessage;
    const ok = res.ok && !!msg?.Sid && !/fail/i.test(String(msg?.Status ?? ""));
    const error = ok
      ? null
      : String(data?.RestException?.Message ?? msg?.DetailedStatus ?? msg?.Status ?? `HTTP ${res.status}`);
    return { success: ok, messageId: msg?.Sid ? String(msg.Sid) : null, error, raw: data };
  } catch (err) {
    return { success: false, messageId: null, error: err instanceof Error ? err.message : "network_error", raw: null };
  }
}
