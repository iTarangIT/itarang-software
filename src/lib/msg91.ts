// ─── MSG91 OTP API ──────────────────────────────────────────────────────────
// Wraps MSG91's purpose-built OTP endpoints:
//   POST /api/v5/otp           → send OTP via SMS using an approved template
//   GET  /api/v5/otp/verify    → MSG91-managed verification (we don't use this;
//                                 we keep our existing local-hash compare so the
//                                 step-5 flow stays consistent across providers)
//   POST /api/v5/otp/retry     → resend the same OTP via the same channel
//
// We pass our own locally-generated OTP via the `otp` query param, so MSG91
// just delivers the SMS; verification stays local against the SHA-256 hash
// stored in `otp_confirmations.otp_hash`. That keeps the existing rate-limit
// / retry / lock semantics in `/api/lead/[id]/step-5/send-otp/route.ts`
// unchanged — only the wire over which the SMS is delivered is different.
//
// Required env (set in `.env.local`):
//   MSG91_AUTH_KEY     — auth key from MSG91 dashboard → Settings → Authkey
//   MSG91_TEMPLATE_ID  — 24-char hex from MSG91 → OTP product → Templates
// Optional:
//   MSG91_COUNTRY      — default '91' (India dialing prefix; no leading +)
//   MSG91_SENDER_ID    — informational; sender ID is bound to the template

import type { SendSmsResult } from "./sms-types";

const BASE_URL = "https://control.msg91.com/api/v5";

function authKey(): string | null {
  const k = process.env.MSG91_AUTH_KEY?.trim();
  return k && k.length > 5 ? k : null;
}

function templateId(): string | null {
  const t = process.env.MSG91_TEMPLATE_ID?.trim();
  return t && t.length > 5 ? t : null;
}

function countryCode(): string {
  return (process.env.MSG91_COUNTRY || "91").replace(/\D/g, "") || "91";
}

export interface SendMsg91OtpParams {
  /** 10-digit Indian mobile (or with country code — last 10 digits are used). */
  mobile_number: string;
  /** The 6-digit OTP we generated locally. MSG91 will substitute ##OTP## with this. */
  otp: string;
  /** Optional override; falls back to MSG91_TEMPLATE_ID. */
  template_id?: string;
  /** Defaults to 10. MSG91 ignores this when we pass `otp` explicitly but we send it for safety. */
  otp_expiry_minutes?: number;
}

/**
 * Send an OTP via MSG91 OTP API.
 * Returns { skipped: true } when the env isn't configured so the caller can
 * decide whether to fall back to another provider or hard-fail.
 */
export async function sendMsg91Otp(p: SendMsg91OtpParams): Promise<SendSmsResult> {
  const key = authKey();
  const tpl = p.template_id || templateId();
  if (!key || !tpl) {
    return {
      success: false,
      skipped: true,
      messageId: null,
      error: "msg91_disabled",
      raw: null,
    };
  }

  const digits = p.mobile_number.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return {
      success: false,
      messageId: null,
      error: `invalid_mobile:${p.mobile_number}`,
      raw: null,
    };
  }

  const mobile = `${countryCode()}${digits}`;

  const url = new URL(`${BASE_URL}/otp`);
  url.searchParams.set("template_id", tpl);
  url.searchParams.set("mobile", mobile);
  url.searchParams.set("otp", p.otp);
  url.searchParams.set("otp_expiry", String(p.otp_expiry_minutes ?? 10));
  url.searchParams.set("authkey", key);

  console.log(
    `[MSG91 OTP] POST ${BASE_URL}/otp tpl=${tpl.slice(0, 6)}… to=${digits.slice(0, 2)}XXXX${digits.slice(-2)}`,
  );

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
    });

    const data = await res.json().catch(() => ({}));
    const ok =
      res.ok &&
      (String(data?.type ?? "").toLowerCase() === "success" || !!data?.request_id);
    const messageId = data?.request_id ?? data?.requestId ?? null;
    const errorMsg = ok ? null : data?.message ?? data?.error ?? `HTTP ${res.status}`;

    // MSG91 returns type=success even when the SMS is later dropped by the
    // operator (e.g. DLT-template ID missing, sender ID not DLT-registered for
    // recipient circle). Always echo the raw body so the actual failure mode
    // is visible in the server log.
    const rawBody = (() => {
      try { return JSON.stringify(data).slice(0, 400); } catch { return "<unserializable>"; }
    })();
    console.log(
      `[MSG91 OTP] Response status=${res.status} ok=${ok} request_id=${messageId ?? "null"} body=${rawBody}`,
    );

    return { success: ok, messageId, error: errorMsg, raw: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    console.error("[MSG91 OTP] Send failed:", msg);
    return { success: false, messageId: null, error: msg, raw: null };
  }
}

/**
 * Resend the previously-sent OTP via the same channel. Useful when the user
 * doesn't get the first SMS but we don't want to issue a new code.
 * MSG91 supports retry types: text (default), voice.
 */
export async function retryMsg91Otp(params: {
  mobile_number: string;
  retrytype?: "text" | "voice";
}): Promise<SendSmsResult> {
  const key = authKey();
  if (!key) {
    return {
      success: false,
      skipped: true,
      messageId: null,
      error: "msg91_disabled",
      raw: null,
    };
  }

  const digits = params.mobile_number.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return {
      success: false,
      messageId: null,
      error: `invalid_mobile:${params.mobile_number}`,
      raw: null,
    };
  }

  const url = new URL(`${BASE_URL}/otp/retry`);
  url.searchParams.set("authkey", key);
  url.searchParams.set("retrytype", params.retrytype ?? "text");
  url.searchParams.set("mobile", `${countryCode()}${digits}`);

  try {
    const res = await fetch(url.toString(), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && String(data?.type ?? "").toLowerCase() === "success";
    return {
      success: ok,
      messageId: data?.request_id ?? null,
      error: ok ? null : data?.message ?? `HTTP ${res.status}`,
      raw: data,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    return { success: false, messageId: null, error: msg, raw: null };
  }
}
