// ─── 2Factor Voice OTP ───────────────────────────────────────────────────────
// Delivers a 6-digit OTP to the customer via an automated PHONE CALL (2Factor
// reads the code out on a voice call). We generate the OTP ourselves and pass it
// so verification stays local (SHA-256 hash-compare), matching the MSG91 /
// calculator OTP pattern — only the delivery wire differs.
//
//   GET https://2factor.in/API/V1/{api_key}/VOICE/{mobile}/{otp}
//     → { "Status": "Success", "Details": "<session-id>" }  (call placed)
//     → { "Status": "Error",   "Details": "<reason>" }
//
// Env:
//   TWOFACTOR_API_KEY (or TWO_FACTOR_API_KEY) — key from 2Factor dashboard.

const BASE_URL = "https://2factor.in/API/V1";

function apiKey(): string | null {
  const k = (process.env.TWOFACTOR_API_KEY || process.env.TWO_FACTOR_API_KEY || "").trim();
  return k && k.length > 3 ? k : null;
}

export function twoFactorConfigured(): boolean {
  return !!apiKey();
}

export interface SendVoiceOtpResult {
  success: boolean;
  sessionId: string | null;
  error: string | null;
  raw: unknown;
}

/**
 * Place a voice call that reads the given OTP to the customer's mobile.
 * Returns { success:false, error:'twofactor_disabled' } when unconfigured so the
 * caller can fall back to the dev/hardcoded path.
 */
export async function sendTwoFactorVoiceOtp(p: {
  mobile_number: string;
  otp: string;
}): Promise<SendVoiceOtpResult> {
  const key = apiKey();
  if (!key) {
    return { success: false, sessionId: null, error: "twofactor_disabled", raw: null };
  }

  const digits = p.mobile_number.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return { success: false, sessionId: null, error: `invalid_mobile:${p.mobile_number}`, raw: null };
  }

  const url = `${BASE_URL}/${key}/VOICE/${digits}/${encodeURIComponent(p.otp)}`;
  console.log(
    `[2Factor VOICE] GET .../VOICE/${digits.slice(0, 2)}XXXX${digits.slice(-2)}/••••••`,
  );

  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && String((data as any)?.Status ?? "").toLowerCase() === "success";
    const sessionId = ok ? String((data as any)?.Details ?? "") || null : null;
    const error = ok ? null : String((data as any)?.Details ?? `HTTP ${res.status}`);
    console.log(`[2Factor VOICE] status=${res.status} ok=${ok} details=${(data as any)?.Details ?? ""}`);
    return { success: ok, sessionId, error, raw: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    console.error("[2Factor VOICE] send failed:", msg);
    return { success: false, sessionId: null, error: msg, raw: null };
  }
}

/**
 * Deliver the same OTP as an SMS through 2Factor's transactional-OTP route.
 *
 *   GET https://2factor.in/API/V1/{api_key}/SMS/{mobile}/{otp}
 *
 * The VOICE and SMS wallets on a 2Factor account are separate balances. This
 * arm exists so that an empty voice wallet (the failure seen on 2026-08-26,
 * "Insufficient Account Balance") does not take the whole dispatch OTP down
 * while the SMS wallet still has credit.
 */
export async function sendTwoFactorSmsOtp(p: {
  mobile_number: string;
  otp: string;
}): Promise<SendVoiceOtpResult> {
  const key = apiKey();
  if (!key) {
    return { success: false, sessionId: null, error: "twofactor_disabled", raw: null };
  }
  const digits = p.mobile_number.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return { success: false, sessionId: null, error: `invalid_mobile:${p.mobile_number}`, raw: null };
  }
  const url = `${BASE_URL}/${key}/SMS/${digits}/${encodeURIComponent(p.otp)}`;
  console.log(`[2Factor SMS] GET .../SMS/${digits.slice(0, 2)}XXXX${digits.slice(-2)}/••••••`);
  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && String((data as any)?.Status ?? "").toLowerCase() === "success";
    const sessionId = ok ? String((data as any)?.Details ?? "") || null : null;
    const error = ok ? null : String((data as any)?.Details ?? `HTTP ${res.status}`);
    console.log(`[2Factor SMS] status=${res.status} ok=${ok} details=${(data as any)?.Details ?? ""}`);
    return { success: ok, sessionId, error, raw: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    console.error("[2Factor SMS] send failed:", msg);
    return { success: false, sessionId: null, error: msg, raw: null };
  }
}
