// ─── Gupshup SMS / Messaging ────────────────────────────────────────────────
// Wrapper around Gupshup's Messaging API. Supports two modes:
//
//   1. Template mode (production) — required for WhatsApp outside the 24h
//      session window. Set GUPSHUP_TEMPLATE_ID to an approved template UUID
//      and pass `templateParams` in SendSmsParams. Posts to
//      /wa/api/v1/template/msg. Also used for DLT-approved SMS when
//      GUPSHUP_CHANNEL=sms.
//
//   2. Session / free-text mode (sandbox/dev) — sends the raw `message`
//      field. Only works with recipients who messaged the number in the
//      last 24h for WhatsApp, or plain SMS if the sender is DLT-exempt.
//
// Required env:
//   GUPSHUP_SMS_ENABLED=true
//   GUPSHUP_API_KEY=...        → from App → Settings → "App API Key"
//   GUPSHUP_APP_NAME=...       → from App → Settings → "App name" (→ src.name)
//   GUPSHUP_SOURCE=91XXXXXXXXXX → registered sender phone / sender ID
// Optional:
//   GUPSHUP_CHANNEL=sms | whatsapp          (default: sms)
//   GUPSHUP_TEMPLATE_ID=<uuid>              → enables template mode when set
//   GUPSHUP_ENDPOINT=<url>                  → override text/session endpoint

import type { SendSmsParams, SendSmsResult } from "./sms-types";

const GUPSHUP_TEXT_ENDPOINT =
  process.env.GUPSHUP_ENDPOINT || "https://api.gupshup.io/wa/api/v1/msg";
const GUPSHUP_TEMPLATE_ENDPOINT =
  "https://api.gupshup.io/wa/api/v1/template/msg";

function genRefId(): string {
  return `GSH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sendGupshupSms(p: SendSmsParams): Promise<SendSmsResult> {
  const enabled = process.env.GUPSHUP_SMS_ENABLED === "true";
  const apiKey = process.env.GUPSHUP_API_KEY;
  const appName = process.env.GUPSHUP_APP_NAME;
  const source = process.env.GUPSHUP_SOURCE;
  const channel = (process.env.GUPSHUP_CHANNEL || "sms").toLowerCase();
  const templateId = process.env.GUPSHUP_TEMPLATE_ID;

  if (!enabled || !apiKey || !appName || !source) {
    return {
      success: false,
      skipped: true,
      messageId: null,
      error: "gupshup_disabled",
      raw: null,
    };
  }

  const digits = (p.mobile_number || "").replace(/\D/g, "");
  // Gupshup wants the full international form (country code + 10 digits).
  // If the caller only gave us 10 digits, assume India (91).
  const destination =
    digits.length === 10 ? `91${digits}` : digits.length >= 11 ? digits : "";

  if (!destination) {
    return {
      success: false,
      messageId: null,
      error: `invalid_mobile:${p.mobile_number}`,
      raw: null,
    };
  }

  const refId = p.reference_id || genRefId();

  // Template mode: only when a template id is configured AND caller supplied
  // the ordered params. Without params we'd post an empty {{1}}, which
  // Gupshup rejects — safer to fall back to session text and let the
  // recipient's 24h window (if any) carry the send.
  const useTemplate = Boolean(templateId) && Array.isArray(p.templateParams);

  const form = new URLSearchParams();
  form.set("source", source);
  form.set("destination", destination);
  form.set("src.name", appName);

  let endpoint: string;
  let mode: "template" | "text";

  if (useTemplate) {
    form.set(
      "template",
      JSON.stringify({ id: templateId, params: p.templateParams ?? [] }),
    );
    endpoint = GUPSHUP_TEMPLATE_ENDPOINT;
    mode = "template";
  } else {
    form.set("channel", channel);
    // WhatsApp session text expects JSON; SMS wants plain body.
    if (channel === "whatsapp") {
      form.set("message", JSON.stringify({ type: "text", text: p.message }));
    } else {
      form.set("message", p.message);
    }
    endpoint = GUPSHUP_TEXT_ENDPOINT;
    mode = "text";
  }

  console.log(
    `[Gupshup SMS] POST ${endpoint} mode=${mode} channel=${channel} to=${destination.slice(0, 4)}XXXX${destination.slice(-2)} ref=${refId}`,
  );

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    });

    const data = await res.json().catch(() => ({}));
    // Gupshup returns { status: "submitted", messageId: "..." } on success.
    const status = String(data?.status ?? "").toLowerCase();
    const ok = res.ok && (status === "submitted" || status === "success");
    const messageId = data?.messageId ?? data?.message_id ?? null;
    const errorMsg = ok
      ? null
      : data?.message ?? data?.error ?? `HTTP ${res.status}`;

    console.log(
      `[Gupshup SMS] Response mode=${mode} status=${res.status} ok=${ok} messageId=${messageId ?? "null"}`,
    );

    return { success: ok, messageId, error: errorMsg, raw: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    console.error("[Gupshup SMS] Send failed:", msg);
    return { success: false, messageId: null, error: msg, raw: null };
  }
}
