/**
 * E2E check for the Step-5 dispatch OTP send + verify flow.
 * Drives the REAL route handlers (send-otp, verify-otp) against the dev DB, with
 * OTP providers force-disabled so the "123456" dev fallback is used and NO real
 * voice call / SMS is placed to the (real) lead's phone. Auth is stubbed at the
 * module level (CommonJS require cache) so requireRole returns a fake dealer.
 * Cleans up all rows it creates and restores the lead afterwards.
 *
 * Run: node --import tsx --env-file=.env.local scripts/e2e-step5-otp.ts
 */

// MUST run before the route modules are required (providers are read at call time).
delete process.env.TWOFACTOR_API_KEY;
delete process.env.TWO_FACTOR_API_KEY;
delete process.env.MSG91_AUTH_KEY;
delete process.env.MSG91_TEMPLATE_ID;

import { and, desc, eq, isNotNull, notInArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, otpConfirmations } from "@/lib/db/schema";

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

// ── Minimal fakes for the Next route handler signature ──────────────────────
function fakeReq(body: unknown) {
  return { json: async () => body } as unknown as import("next/server").NextRequest;
}
function ctx(leadId: string) {
  return { params: Promise.resolve({ id: leadId }) };
}

// Replace requireRole in the cached auth-utils module with a stub. tsx compiles
// exports as non-configurable getters, so we swap the module's `exports` object
// in require.cache for a Proxy that overrides only requireRole and passes the
// rest through. Must run before the route modules are required.
function stubRequireRole(mock: () => Promise<unknown>) {
  require("@/lib/auth-utils"); // ensure it's in the cache
  const key = Object.keys(require.cache).find((k) =>
    k.replace(/\\/g, "/").endsWith("/lib/auth-utils.ts"),
  );
  if (!key) throw new Error("auth-utils not found in require.cache");
  const real = require.cache[key]!.exports;
  require.cache[key]!.exports = new Proxy(real, {
    get(t, p) {
      return p === "requireRole" ? mock : Reflect.get(t, p);
    },
  });
}

async function main() {
  // Pick a real lead with a phone + a dealer, and (ideally) no live OTP rows.
  const candidates = await db
    .select({
      id: leads.id,
      phone: leads.phone,
      mobile: leads.mobile,
      dealer_id: leads.dealer_id,
      kyc_status: leads.kyc_status,
      full_name: leads.full_name,
    })
    .from(leads)
    .where(and(isNotNull(leads.dealer_id), or(isNotNull(leads.phone), isNotNull(leads.mobile))))
    .orderBy(desc(leads.created_at))
    .limit(50);

  const chosen = candidates.find((l) => (l.phone || l.mobile) && l.dealer_id);
  if (!chosen) {
    console.error("No suitable lead (dealer_id + phone) found. Aborting.");
    process.exit(1);
  }

  const leadId = chosen.id;
  const originalKyc = chosen.kyc_status ?? null;

  // Fake dealer that OWNS this lead so the routes' ownership check passes.
  stubRequireRole(async () => ({
    id: "00000000-0000-0000-0000-000000000000",
    dealer_id: chosen.dealer_id,
    role: "dealer",
    email: "test-dealer@itarang.com",
    name: "Test Dealer",
  }));

  // Require the REAL route handlers AFTER the stub is in place.
  const sendOtp = require("@/app/api/lead/[id]/step-5/send-otp/route").POST;
  const verifyOtp = require("@/app/api/lead/[id]/step-5/verify-otp/route").POST;

  console.log(`\nUsing lead ${leadId} (${chosen.full_name ?? "?"}, phone ${chosen.phone ?? chosen.mobile})`);
  console.log(`Original kyc_status = ${originalKyc ?? "(null)"}\n`);

  // Baseline: OTP rows that already exist for this lead (so cleanup only removes ours).
  const baseline = (
    await db.select({ id: otpConfirmations.id }).from(otpConfirmations).where(eq(otpConfirmations.lead_id, leadId))
  ).map((r) => r.id);

  try {
    // Precondition: Step-5 OTP is only available once the loan is sanctioned.
    await db.update(leads).set({ kyc_status: "loan_sanctioned" }).where(eq(leads.id, leadId));

    // Start from a clean OTP session (remove any pre-existing rows for this lead
    // so send #1 begins a fresh session — they're ephemeral and re-created here).
    await db.delete(otpConfirmations).where(eq(otpConfirmations.lead_id, leadId));

    // ── 1. Send OTP (dev fallback, no real call) ──────────────────────────────
    console.log("[1] POST send-otp");
    const r1 = await sendOtp(fakeReq({}), ctx(leadId));
    const j1 = await r1.json();
    check("send returned 200", r1.status === 200, `status=${r1.status}`);
    check("success = true", j1.success === true, JSON.stringify(j1));
    check("dev OTP surfaced (123456)", j1.data?._devOtp === "123456", `_devOtp=${j1.data?._devOtp}`);
    check("deliveryStatus = dev_hardcoded", j1.data?.deliveryStatus === "dev_hardcoded", j1.data?.deliveryStatus);
    check("otpSentTo masked", /^XXXXXX\d{4}$/.test(j1.data?.otpSentTo ?? ""), j1.data?.otpSentTo);
    check("sendCount = 1", j1.data?.sendCount === 1, `sendCount=${j1.data?.sendCount}`);

    const rowAfterSend = await latestOtp(leadId);
    check("otp_confirmations row created", !!rowAfterSend, "(none)");
    check("row not yet used", rowAfterSend?.is_used === false, `is_used=${rowAfterSend?.is_used}`);
    check("send_count = 1", rowAfterSend?.send_count === 1, `send_count=${rowAfterSend?.send_count}`);

    // ── 2. Verify WRONG OTP → rejected, attempt counted, NOT consumed ─────────
    console.log("\n[2] POST verify-otp (wrong 000000)");
    const r2 = await verifyOtp(fakeReq({ otp: "000000" }), ctx(leadId));
    const j2 = await r2.json();
    check("wrong OTP → 400", r2.status === 400, `status=${r2.status}`);
    check("success = false", j2.success === false, JSON.stringify(j2));
    const rowAfterWrong = await latestOtp(leadId);
    check("attempt_count incremented to 1", rowAfterWrong?.attempt_count === 1, `attempt_count=${rowAfterWrong?.attempt_count}`);
    check("still NOT used after wrong verify", rowAfterWrong?.is_used === false, `is_used=${rowAfterWrong?.is_used}`);

    // ── 3. Verify CORRECT OTP → verified, attempts reset, still NOT consumed ──
    console.log("\n[3] POST verify-otp (correct 123456)");
    const r3 = await verifyOtp(fakeReq({ otp: "123456" }), ctx(leadId));
    const j3 = await r3.json();
    check("correct OTP → 200", r3.status === 200, `status=${r3.status}`);
    check("verified = true", j3.success === true && j3.data?.verified === true, JSON.stringify(j3));
    const rowAfterVerify = await latestOtp(leadId);
    check("attempt_count reset to 0", rowAfterVerify?.attempt_count === 0, `attempt_count=${rowAfterVerify?.attempt_count}`);
    check("OTP NOT consumed (is_used=false)", rowAfterVerify?.is_used === false, `is_used=${rowAfterVerify?.is_used}`);

    // ── 4. Verify again is a no-op success (proves dispatch stays enabled) ────
    console.log("\n[4] POST verify-otp again (non-consuming re-check)");
    const r4 = await verifyOtp(fakeReq({ otp: "123456" }), ctx(leadId));
    const j4 = await r4.json();
    check("re-verify still succeeds", r4.status === 200 && j4.data?.verified === true, JSON.stringify(j4));

    // ── 5. Resend cap: send_count reaches 3, 4th send is a cooldown 429 ───────
    console.log("\n[5] resend cap (send until 3, then 429)");
    const r5b = await sendOtp(fakeReq({}), ctx(leadId));
    const j5b = await r5b.json();
    check("send #2 ok, sendCount=2", r5b.status === 200 && j5b.data?.sendCount === 2, `status=${r5b.status} sendCount=${j5b.data?.sendCount}`);
    const r5c = await sendOtp(fakeReq({}), ctx(leadId));
    const j5c = await r5c.json();
    check("send #3 ok, sendCount=3", r5c.status === 200 && j5c.data?.sendCount === 3, `status=${r5c.status} sendCount=${j5c.data?.sendCount}`);
    const r5d = await sendOtp(fakeReq({}), ctx(leadId));
    const j5d = await r5d.json();
    check("send #4 blocked (429 cooldown)", r5d.status === 429 && j5d.success === false, `status=${r5d.status} ${JSON.stringify(j5d.error)}`);
  } finally {
    // ── Cleanup: delete only the OTP rows we created + restore lead status ────
    console.log("\n[cleanup] removing test OTP rows + restoring lead status");
    if (baseline.length > 0) {
      await db
        .delete(otpConfirmations)
        .where(and(eq(otpConfirmations.lead_id, leadId), notInArray(otpConfirmations.id, baseline)));
    } else {
      await db.delete(otpConfirmations).where(eq(otpConfirmations.lead_id, leadId));
    }
    await db.update(leads).set({ kyc_status: originalKyc }).where(eq(leads.id, leadId));
    console.log("  ✅ cleanup done");
  }

  console.log(`\n──────── ${pass} passed, ${fail} failed ────────`);
  process.exit(fail === 0 ? 0 : 1);
}

async function latestOtp(leadId: string) {
  const [r] = await db
    .select()
    .from(otpConfirmations)
    .where(eq(otpConfirmations.lead_id, leadId))
    .orderBy(desc(otpConfirmations.created_at))
    .limit(1);
  return r;
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
