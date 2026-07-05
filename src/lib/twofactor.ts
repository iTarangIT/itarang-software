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
