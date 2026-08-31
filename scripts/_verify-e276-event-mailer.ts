// E-276 end-to-end test of the NBFC event mailer.
//
//   node --import tsx --env-file=.env.local scripts/_verify-e276-event-mailer.ts
//
// 1. READ-ONLY: prints every tenant's recipient-resolution chain
//    (channels.notification_email → tenants.contact_email → nbfc.primary_contact_email).
// 2. LIVE SEND: temporarily points ONE tenant's notification_email at the test
//    inbox (so no real NBFC receives a test mail), fires sendNbfcEventEmail
//    through the real helper + mailer, then restores the previous value.
// 3. LIVE SEND: tenantId=null → proves the global-inbox-only fallback.
//
// Success = two mails in the NBFC_GLOBAL_NOTIFY_EMAIL inbox.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcNotificationChannels, nbfcTenants } from "@/lib/db/schema";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";

const TEST_INBOX = process.env.NBFC_GLOBAL_NOTIFY_EMAIL?.trim();

async function main() {
  console.log("DB HOST:", new URL(process.env.DATABASE_URL!).hostname);
  console.log("GLOBAL :", TEST_INBOX ?? "(unset!)");
  if (!TEST_INBOX) throw new Error("NBFC_GLOBAL_NOTIFY_EMAIL is not set — nothing to test against");

  // ---- 1. resolution table (read-only) -----------------------------------
  const tenants = await db
    .select({
      id: nbfcTenants.id,
      slug: nbfcTenants.slug,
      contact: nbfcTenants.contact_email,
      active: nbfcTenants.is_active,
    })
    .from(nbfcTenants);
  console.log(`\n${tenants.length} tenants — recipient resolution:`);
  for (const t of tenants) {
    const [ch] = await db
      .select({ email: nbfcNotificationChannels.notification_email })
      .from(nbfcNotificationChannels)
      .where(eq(nbfcNotificationChannels.tenant_id, t.id))
      .limit(1);
    const [m] = await db
      .select({ email: nbfc.primary_contact_email })
      .from(nbfc)
      .where(eq(nbfc.tenant_id, t.id))
      .limit(1);
    const resolved = ch?.email?.trim() || t.contact?.trim() || m?.email?.trim() || "(global inbox only)";
    const via = ch?.email?.trim()
      ? "channels.notification_email"
      : t.contact?.trim()
        ? "tenants.contact_email"
        : m?.email?.trim()
          ? "nbfc.primary_contact_email"
          : "none";
    console.log(`  ${t.slug}${t.active ? "" : " (inactive)"} → ${resolved}  [${via}]`);
  }

  // ---- 2. live send through the real helper (override + restore) ---------
  const target = tenants.find((t) => t.active) ?? tenants[0];
  if (!target) throw new Error("no nbfc_tenants rows — cannot test the tenant path");
  console.log(`\nTest tenant: ${target.slug} (${target.id})`);

  const [existingRow] = await db
    .select()
    .from(nbfcNotificationChannels)
    .where(eq(nbfcNotificationChannels.tenant_id, target.id))
    .limit(1);
  const previous = existingRow?.notification_email ?? null;

  if (existingRow) {
    await db
      .update(nbfcNotificationChannels)
      .set({ notification_email: TEST_INBOX, updated_at: new Date() })
      .where(eq(nbfcNotificationChannels.tenant_id, target.id));
  } else {
    await db.insert(nbfcNotificationChannels).values({ tenant_id: target.id, notification_email: TEST_INBOX });
  }
  console.log(`  notification_email temporarily set to ${TEST_INBOX} (was: ${previous ?? "null"})`);

  try {
    await sendNbfcEventEmail({
      tenantId: target.id,
      leadId: "TEST-E276",
      subject: `iTarang TEST — E-276 NBFC event mail (tenant path, ${new Date().toISOString()})`,
      eventLabel: "TEST: Dealer Demo Motors has sent a new customer loan file to your NBFC account.",
      customerName: "Test Customer",
      dealerName: "Demo Motors (DLR-TEST)",
      files: ["aadhaar_front.jpg", "pan_card.pdf", "bank_statement_6m.pdf"],
      extraRows: [
        ["Loan product", "EV Battery Loan 12m"],
        ["Requested loan amount", "₹45,000"],
      ],
      bodyHtml: `<p>E-276 verification: resolved via <b>nbfc_notification_channels.notification_email</b> for tenant <b>${target.slug}</b>. To = NBFC notification email, CC = global monitoring inbox (same address here, so CC is deduped away).</p>`,
    });
    console.log("  tenant-path send: dispatched (watch console for [nbfc-event-mailer] warnings — none = OK)");
  } finally {
    await db
      .update(nbfcNotificationChannels)
      .set({ notification_email: previous, updated_at: new Date() })
      .where(eq(nbfcNotificationChannels.tenant_id, target.id));
    console.log(`  notification_email restored to: ${previous ?? "null"}`);
  }

  // ---- 3. global-only fallback (tenantId null) ---------------------------
  await sendNbfcEventEmail({
    tenantId: null,
    subject: `iTarang TEST — E-276 global-fallback mail (${new Date().toISOString()})`,
    bodyHtml: `<p>E-276 verification: no tenant → delivered to the monitoring inbox alone.</p>`,
  });
  console.log("  global-fallback send: dispatched");

  console.log(`\nDone. Check ${TEST_INBOX} for TWO test mails.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
