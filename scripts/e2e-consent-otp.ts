/**
 * E2E check for OTP-based consent (E-180). Exercises the REAL service functions
 * (sendConsentOtp / verifyConsentOtp) against the dev DB, then cleans up.
 *
 * Run: node --import tsx --env-file=.env.local scripts/e2e-consent-otp.ts
 *
 * Providers are force-disabled below so the dev "123456" fallback is used and NO
 * real SMS/WhatsApp is sent to the (real) lead's phone.
 */

// MUST run before importing consent-service (which reads these at call time).
delete process.env.MSG91_AUTH_KEY;
delete process.env.MSG91_TEMPLATE_ID;
delete process.env.META_WA_ACCESS_TOKEN;
delete process.env.META_WA_PHONE_NUMBER_ID;
delete process.env.TWOFACTOR_API_KEY;
delete process.env.TWO_FACTOR_API_KEY;

import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { consentOtpVerifications, consentRecords, leads } from "@/lib/db/schema";
import { sendConsentOtp, verifyConsentOtp } from "@/lib/kyc/consent-service";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  // ── Pick a real lead with a phone and NO existing primary consent record ────
  const candidates = await db
    .select({
      id: leads.id,
      phone: leads.phone,
      owner_contact: leads.owner_contact,
      full_name: leads.full_name,
      consent_status: leads.consent_status,
    })
    .from(leads)
    .where(or(isNotNull(leads.phone), isNotNull(leads.owner_contact)))
    .orderBy(desc(leads.created_at))
    .limit(150);

  let chosen: (typeof candidates)[number] | undefined;
  for (const l of candidates) {
    if (!(l.phone || l.owner_contact)) continue;
    const existing = await db
      .select({ id: consentRecords.id })
      .from(consentRecords)
      .where(and(eq(consentRecords.lead_id, l.id), eq(consentRecords.consent_for, "primary")));
    if (existing.length === 0) {
      chosen = l;
      break;
    }
  }

  if (!chosen) {
    console.error("No suitable lead (phone + no primary consent record) found. Aborting.");
    process.exit(1);
  }

  const leadId = chosen.id;
  const originalLeadConsentStatus = chosen.consent_status ?? null;
  console.log(`\nUsing lead ${leadId} (${chosen.full_name ?? "?"}, phone ${chosen.phone ?? chosen.owner_contact})`);
  console.log(`Original leads.consent_status = ${originalLeadConsentStatus ?? "(null)"}\n`);

  try {
    // ── 1. Send OTP ───────────────────────────────────────────────────────────
    console.log("[1] sendConsentOtp(channel=sms)");
    const sent = await sendConsentOtp({ leadId, channel: "sms", consentFor: "customer" });
    check("send returned ok", sent.ok, JSON.stringify(sent));
    if (!sent.ok) throw new Error("send failed: " + sent.error);
    check("dev OTP surfaced (123456)", sent.devOtp === "123456", `devOtp=${sent.devOtp}`);
    check("deliveryStatus = dev_hardcoded", sent.deliveryStatus === "dev_hardcoded", sent.deliveryStatus);
    check("otpSentTo masked", /^XXXXXX\d{4}$/.test(sent.otpSentTo), sent.otpSentTo);

    const recAfterSend = await latestRecord(leadId);
    check("consent_records.consent_status = otp_sent", recAfterSend?.consent_status === "otp_sent", recAfterSend?.consent_status ?? "(none)");
    check("sign_method = otp", recAfterSend?.sign_method === "otp", recAfterSend?.sign_method ?? "(none)");
    check("consent_delivery_channel = sms", recAfterSend?.consent_delivery_channel === "sms", recAfterSend?.consent_delivery_channel ?? "(none)");

    const otpRow = await latestOtp(leadId);
    check("consent_otp_verifications row created", !!otpRow, "(none)");
    check("otp session not yet verified", !!otpRow && otpRow.verifiedAt === null);

    // ── 2. Wrong OTP → attemptsRemaining ───────────────────────────────────────
    console.log("\n[2] verifyConsentOtp(wrong otp)");
    const wrong = await verifyConsentOtp({ leadId, otp: "000000", consentFor: "customer" });
    check("wrong OTP rejected", !wrong.ok, JSON.stringify(wrong));
    check(
      "attemptsRemaining returned (2)",
      !wrong.ok && wrong.attemptsRemaining === 2,
      !wrong.ok ? `attemptsRemaining=${wrong.attemptsRemaining}` : "was ok",
    );
    const recAfterWrong = await latestRecord(leadId);
    check("still otp_sent after wrong attempt", recAfterWrong?.consent_status === "otp_sent", recAfterWrong?.consent_status ?? "(none)");

    // ── 3. Correct OTP → auto-complete to verified ─────────────────────────────
    console.log("\n[3] verifyConsentOtp(correct otp = 123456)");
    const ok = await verifyConsentOtp({ leadId, otp: "123456", consentFor: "customer" });
    check("verify returned ok", ok.ok, JSON.stringify(ok));
    check("consentStatus = verified", ok.ok && ok.consentStatus === "verified");

    const recFinal = await latestRecord(leadId);
    check("consent_records.consent_status = verified", recFinal?.consent_status === "verified", recFinal?.consent_status ?? "(none)");
    check("signed_at set", !!recFinal?.signed_at);
    check("verified_at set", !!recFinal?.verified_at);
    check("otp_verified_at set", !!recFinal?.otp_verified_at);
    check("otp_verification_id set", !!recFinal?.otp_verification_id);
    check("signed_consent_url populated from preview", !!recFinal?.signed_consent_url, recFinal?.signed_consent_url ?? "(null)");

    const leadFinal = await db.select({ cs: leads.consent_status }).from(leads).where(eq(leads.id, leadId)).limit(1);
    check("leads.consent_status propagated to verified", leadFinal[0]?.cs === "verified", leadFinal[0]?.cs ?? "(null)");

    const otpFinal = await latestOtp(leadId);
    check("otp session stamped verified_at", !!otpFinal?.verifiedAt);

    // ── 4. Re-verify is now a no-op (session consumed) ─────────────────────────
    console.log("\n[4] verifyConsentOtp again (session already verified)");
    const again = await verifyConsentOtp({ leadId, otp: "123456", consentFor: "customer" });
    check("re-verify rejected (no active OTP)", !again.ok, JSON.stringify(again));
  } finally {
    // ── Cleanup: remove test rows + restore the lead's consent status ──────────
    console.log("\n[cleanup] removing test rows + restoring lead status");
    await db.delete(consentOtpVerifications).where(eq(consentOtpVerifications.leadId, leadId));
    await db.delete(consentRecords).where(and(eq(consentRecords.lead_id, leadId), eq(consentRecords.consent_for, "primary")));
    await db
      .update(leads)
      .set({ consent_status: originalLeadConsentStatus, updated_at: new Date() })
      .where(eq(leads.id, leadId));
    console.log("  ✅ cleanup done");
  }

  console.log(`\n──────── ${pass} passed, ${fail} failed ────────`);
  process.exit(fail === 0 ? 0 : 1);
}

async function latestRecord(leadId: string) {
  const [r] = await db
    .select()
    .from(consentRecords)
    .where(and(eq(consentRecords.lead_id, leadId), eq(consentRecords.consent_for, "primary")))
    .orderBy(desc(consentRecords.created_at))
    .limit(1);
  return r;
}

async function latestOtp(leadId: string) {
  const [r] = await db
    .select()
    .from(consentOtpVerifications)
    .where(and(eq(consentOtpVerifications.leadId, leadId), eq(consentOtpVerifications.consentFor, "primary")))
    .orderBy(desc(consentOtpVerifications.createdAt))
    .limit(1);
  return r;
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
