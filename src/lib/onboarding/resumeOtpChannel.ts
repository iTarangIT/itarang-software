// Where the "continue my application" code goes (tracker ID 166 decision 5 /
// ID 119): the dealer continues the onboarding form after a MOBILE OTP. The
// code goes to the owner mobile ON THE APPLICATION by SMS (2Factor, then
// MSG91, then a 2Factor voice call); the owner email on the application is the
// fallback when there is no usable mobile or every SMS provider fails.
//
// Pure half (no db, no providers): number shape, masking and the dry-run
// switch, so it unit-tests alone. The sending is in resumeOtpDelivery.ts.

/** A 10-digit Indian mobile from what the form stored (+91, 0 and spaces dropped), or null. */
export function resumeOtpMobile(raw: string | null | undefined): string | null {
    let digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** XXXXXX1234 — enough to recognise your own number. */
export function maskMobile(mobile: string): string {
    const digits = mobile.replace(/\D/g, "");
    return digits.length >= 4 ? `XXXXXX${digits.slice(-4)}` : "your registered mobile";
}

/**
 * Dry run: the code is written to the server log and nothing is sent.
 * OTP_DRY_RUN=1 forces it (local runs with live provider keys); tests always
 * run dry.
 */
export function resumeOtpDryRun(env: Record<string, string | undefined> = process.env): boolean {
    const flag = (env.OTP_DRY_RUN ?? "").trim().toLowerCase();
    return flag === "1" || flag === "true" || env.NODE_ENV === "test" || env.VITEST === "true";
}

export type ResumeOtpChannel = "sms" | "call" | "email" | "dev";

/** The sentence the form shows after sending ("…we sent to XXXXXX1234 by SMS"). */
export function resumeOtpSentWhere(channel: ResumeOtpChannel, masked: string): string {
    if (channel === "email") return `${masked} by email`;
    if (channel === "call") return `${masked} by a phone call`;
    return `${masked} by SMS`;
}
