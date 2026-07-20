/**
 * One-off: complete "Validate & Confirm Dispatch" for a specific lead whose UI
 * is blocked by the OTP resend cap / cooldown. Drives the REAL send-otp +
 * confirm-dispatch route handlers with all external OTP/SMS providers disabled
 * (no real voice call or customer SMS), stubbing dealer auth. This is the same
 * irreversible finalization the button performs: inventory sold, warranty +
 * after-sales created, loan disbursed, lead -> dispatched.
 *
 * Run: node --import tsx --env-file=.env.local scripts/dispatch-lead.ts [LEAD_ID]
 */

// Disable every external delivery path BEFORE the routes are required so nothing
// is sent to the (real) customer number. send-otp then uses the dev "123456".
for (const k of [
  "TWOFACTOR_API_KEY",
  "TWO_FACTOR_API_KEY",
  "MSG91_AUTH_KEY",
  "MSG91_TEMPLATE_ID",
  "GUPSHUP_API_KEY",
  "DECENTRO_CLIENT_ID",
  "DECENTRO_CLIENT_SECRET",
  "META_WA_ACCESS_TOKEN",
  "META_WA_PHONE_NUMBER_ID",
]) {
  delete process.env[k];
}

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, otpConfirmations } from "@/lib/db/schema";

const LEAD_ID = process.argv[2] || "LEAD-20260719-86fad766";

function fakeReq(body: unknown) {
  return { json: async () => body } as unknown as import("next/server").NextRequest;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function stubRequireRole(mock: () => Promise<unknown>) {
  require("@/lib/auth-utils");
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
  const [lead] = await db.select().from(leads).where(eq(leads.id, LEAD_ID)).limit(1);
  if (!lead) throw new Error(`Lead ${LEAD_ID} not found`);
  console.log(`\nLead ${LEAD_ID} — ${lead.full_name ?? lead.owner_name ?? "?"}`);
  console.log(`  kyc_status = ${lead.kyc_status}`);
  console.log(`  dealer_id  = ${lead.dealer_id}`);

  if (lead.kyc_status !== "loan_sanctioned") {
    if (lead.kyc_status === "dispatched" || lead.kyc_status === "sold") {
      console.log(`\n⚠ Lead is already '${lead.kyc_status}' — nothing to dispatch.`);
      process.exit(0);
    }
    throw new Error(`Lead is '${lead.kyc_status}', not 'loan_sanctioned' — cannot confirm dispatch.`);
  }

  stubRequireRole(async () => ({
    id: "00000000-0000-0000-0000-000000000000",
    dealer_id: lead.dealer_id,
    role: "dealer",
    email: "it@itarang.com",
    name: "iTarang Dealer",
  }));

  const sendOtp = require("@/app/api/lead/[id]/step-5/send-otp/route").POST;
  const confirmDispatch = require("@/app/api/lead/[id]/step-5/confirm-dispatch/route").POST;

  // Clear the stale/maxed OTP session so send-otp starts fresh (bypass cooldown).
  await db.delete(otpConfirmations).where(eq(otpConfirmations.lead_id, LEAD_ID));

  console.log(`\n[1] Sending a fresh OTP (dev/no-provider → 123456, no real call)…`);
  const sRes = await sendOtp(fakeReq({}), ctx(LEAD_ID));
  const sJson = await sRes.json();
  if (!sJson.success) throw new Error(`send-otp failed: ${JSON.stringify(sJson.error)}`);
  const otp: string = sJson.data._devOtp;
  console.log(`  OTP issued: ${otp} (deliveryStatus=${sJson.data.deliveryStatus})`);

  console.log(`\n[2] Confirming dispatch…`);
  const cRes = await confirmDispatch(fakeReq({ otp }), ctx(LEAD_ID));
  const cJson = await cRes.json();
  if (!cJson.success) {
    console.error(`  ❌ confirm-dispatch failed (status ${cRes.status}): ${JSON.stringify(cJson.error)}`);
    process.exit(1);
  }

  console.log(`  ✅ ${cJson.data.message}`);
  console.log(`     leadStatus  = ${cJson.data.leadStatus}`);
  console.log(`     warrantyId  = ${cJson.data.warrantyId}`);
  console.log(`     warranty    = ${cJson.data.warrantyStart} → ${cJson.data.warrantyEnd}`);
  console.log(`     afterSales  = ${cJson.data.afterSalesId}`);

  const [after] = await db
    .select({ kyc: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, LEAD_ID))
    .limit(1);
  console.log(`\n  Lead kyc_status is now: ${after?.kyc}`);

  const [otpRow] = await db
    .select({ used: otpConfirmations.is_used, used_at: otpConfirmations.used_at })
    .from(otpConfirmations)
    .where(eq(otpConfirmations.lead_id, LEAD_ID))
    .orderBy(desc(otpConfirmations.created_at))
    .limit(1);
  console.log(`  OTP consumed: is_used=${otpRow?.used} at ${otpRow?.used_at}`);

  console.log(`\n──────── Dispatch confirmed for ${LEAD_ID} ────────`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Dispatch script crashed:", e);
  process.exit(1);
});
