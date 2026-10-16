// Sends the "continue my application" code (tracker ID 166 decision 5 / ID
// 119): mobile first, email as the fallback. The rules are in
// resumeOtpChannel.ts; this file only talks to the providers.
//
// Server-only.

import { sendOnboardingResumeOtpEmail } from "@/lib/email/sendOnboardingResumeOtpEmail";
import { sendMsg91Otp } from "@/lib/msg91";
import { sendTwoFactorSmsOtp, sendTwoFactorVoiceOtp, twoFactorConfigured } from "@/lib/twofactor";
import { RESUME_OTP_TTL_MS, maskEmail } from "@/lib/onboarding/submitAccess";
import {
    maskMobile,
    resumeOtpDryRun,
    resumeOtpMobile,
    type ResumeOtpChannel,
} from "@/lib/onboarding/resumeOtpChannel";

export type ResumeOtpDelivery =
    | { ok: true; channel: ResumeOtpChannel; sentTo: string; maskedTo: string; errors: string[] }
    | { ok: false; errors: string[] };

function msg91Configured(): boolean {
    return !!(process.env.MSG91_AUTH_KEY?.trim() && process.env.MSG91_TEMPLATE_ID?.trim());
}

export async function deliverResumeOtp(p: {
    ownerPhone: string | null;
    ownerEmail: string | null;
    ownerName: string | null;
    companyName: string | null;
    code: string;
    expiresAt: Date;
}): Promise<ResumeOtpDelivery> {
    const mobile = resumeOtpMobile(p.ownerPhone);
    const email = (p.ownerEmail ?? "").trim() || null;
    const errors: string[] = [];

    if (resumeOtpDryRun()) {
        const to = mobile ?? email;
        if (!to) return { ok: false, errors: ["no mobile or email on the application"] };
        console.log(`[onboarding/resume] DRY RUN code for ${mobile ? maskMobile(mobile) : maskEmail(email)}: ${p.code}`);
        return { ok: true, channel: "dev", sentTo: to, maskedTo: mobile ? maskMobile(mobile) : maskEmail(email), errors };
    }

    if (mobile) {
        if (twoFactorConfigured()) {
            const sms = await sendTwoFactorSmsOtp({ mobile_number: mobile, otp: p.code });
            if (sms.success) return { ok: true, channel: "sms", sentTo: mobile, maskedTo: maskMobile(mobile), errors };
            errors.push(`2Factor SMS: ${sms.error}`);
        }
        if (msg91Configured()) {
            const sms = await sendMsg91Otp({
                mobile_number: mobile,
                otp: p.code,
                otp_expiry_minutes: Math.round(RESUME_OTP_TTL_MS / 60_000),
            });
            if (sms.success) return { ok: true, channel: "sms", sentTo: mobile, maskedTo: maskMobile(mobile), errors };
            errors.push(`MSG91: ${sms.error}`);
        }
        if (twoFactorConfigured()) {
            const call = await sendTwoFactorVoiceOtp({ mobile_number: mobile, otp: p.code });
            if (call.success) return { ok: true, channel: "call", sentTo: mobile, maskedTo: maskMobile(mobile), errors };
            errors.push(`2Factor call: ${call.error}`);
        }
        if (!twoFactorConfigured() && !msg91Configured()) errors.push("no SMS provider configured");
        if (errors.length) console.error("[onboarding/resume] mobile code not delivered:", errors.join("; "));
    } else {
        errors.push("no usable mobile on the application");
    }

    if (email) {
        try {
            await sendOnboardingResumeOtpEmail({
                toEmail: email,
                ownerName: p.ownerName,
                companyName: p.companyName,
                code: p.code,
                expiresAt: p.expiresAt,
            });
            return { ok: true, channel: "email", sentTo: email, maskedTo: maskEmail(email), errors };
        } catch (err) {
            errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Local only, no provider and no mailer: the dev path every OTP here has.
    if (process.env.NODE_ENV !== "production" && (mobile || email)) {
        console.log(`[onboarding/resume] DEV code: ${p.code}`);
        const to = (mobile ?? email)!;
        return { ok: true, channel: "dev", sentTo: to, maskedTo: mobile ? maskMobile(mobile) : maskEmail(email), errors };
    }
    return { ok: false, errors };
}
