/**
 * Daily cron — NBFC origination maintenance. Three sweeps:
 *   1. Manual Handoff nudge (§11.7 MH-4): for each handoff still in `sent` whose
 *      last nudge is > 24h old, email the admin to chase + bump nudge_count.
 *   2. E-NACH stale_risk (§9.4): flag mandates whose registration is > 90 days
 *      old and still operative (Decentro mandates unpresented within 120 days
 *      become unusable; the 120-day rule is a post-disbursal boundary item).
 *   3. FI SLA breach (§6.3): flag field investigations past their 48h SLA.
 *
 * Schedule: daily (configure in vercel.json). Auth: Vercel cron header OR
 * Bearer CRON_SECRET; unauthenticated allowed in non-production (repo pattern).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates, fieldInvestigations, leads, manualHandoffs, nbfcWallets, users } from "@/lib/db/schema";
import { sendManualHandoffNudge } from "@/lib/email/sendManualHandoffEmail";
import { ENACH_STALE_RISK_DAYS } from "@/lib/nbfc/enach";
import { postTopup } from "@/lib/nbfc/charging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function run() {
  const now = Date.now();
  const nudgeCutoff = new Date(now - 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(now - ENACH_STALE_RISK_DAYS * 24 * 60 * 60 * 1000);

  // 1. Manual Handoff nudges.
  const dueHandoffs = await db
    .select()
    .from(manualHandoffs)
    .where(
      and(
        eq(manualHandoffs.status, "sent"),
        or(isNull(manualHandoffs.last_nudge_at), lt(manualHandoffs.last_nudge_at, nudgeCutoff)),
      ),
    );

  let nudged = 0;
  for (const h of dueHandoffs) {
    try {
      const [adminUser] = h.sent_by
        ? await db.select({ email: users.email }).from(users).where(eq(users.id, h.sent_by)).limit(1)
        : [];
      const [lead] = await db
        .select({ name: leads.full_name, owner_name: leads.owner_name })
        .from(leads)
        .where(eq(leads.id, h.lead_id))
        .limit(1);
      const adminEmail = adminUser?.email || process.env.ADMIN_NOTIFY_EMAIL;
      const emails = Array.isArray(h.sent_to_emails)
        ? (h.sent_to_emails as Array<{ email?: string }>).map((e) => e?.email ?? "").filter(Boolean)
        : [];
      if (adminEmail) {
        await sendManualHandoffNudge({
          toEmail: adminEmail,
          leadId: h.lead_id,
          customerName: lead?.name || lead?.owner_name || "Customer",
          sentToEmails: emails,
          nudgeCount: h.nudge_count,
        });
      }
      await db
        .update(manualHandoffs)
        .set({ last_nudge_at: new Date(), nudge_count: h.nudge_count + 1, updated_at: new Date() })
        .where(eq(manualHandoffs.id, h.id));
      nudged += 1;
    } catch (e) {
      console.error("[origination-maintenance] nudge failed for", h.lead_id, e);
    }
  }

  // 2. E-NACH stale_risk flag.
  const staleResult = await db
    .update(enachMandates)
    .set({ stale_risk: true, updated_at: new Date() })
    .where(
      and(
        inArray(enachMandates.status, ["in_progress", "registered"]),
        eq(enachMandates.stale_risk, false),
        lt(enachMandates.registration_date, staleCutoff),
      ),
    )
    .returning({ id: enachMandates.id });

  // 3. FI SLA breach flag (§10.1) — only the current attempt of each lead×NBFC
  //    that is still awaiting the agent's submission past its 48h window.
  const fiResult = await db
    .update(fieldInvestigations)
    .set({ sla_breached: true, updated_at: new Date() })
    .where(
      and(
        eq(fieldInvestigations.is_current, true),
        inArray(fieldInvestigations.status, ["assigned", "in_progress"]),
        eq(fieldInvestigations.sla_breached, false),
        lt(fieldInvestigations.sla_due_at, new Date()),
      ),
    )
    .returning({ id: fieldInvestigations.id });

  // 4. Auto-NACH wallet recharge (§8.1). For wallets that opted into auto-NACH
  //    and have fallen below their threshold, pull the configured recharge
  //    amount via the NACH mandate. The NACH bank debit itself is owned
  //    off-platform (Model 1 prepaid); here we record the resulting credit so
  //    the prepaid balance reflects the top-up. Best-effort per wallet.
  const lowWallets = await db
    .select({
      tenant_id: nbfcWallets.tenant_id,
      balance: nbfcWallets.balance,
      threshold: nbfcWallets.auto_nach_threshold,
      amount: nbfcWallets.auto_nach_recharge_amount,
    })
    .from(nbfcWallets)
    .where(eq(nbfcWallets.auto_nach_enabled, true));

  let recharged = 0;
  for (const w of lowWallets) {
    const balance = Number(w.balance ?? 0);
    const threshold = w.threshold == null ? null : Number(w.threshold);
    const amount = w.amount == null ? 0 : Number(w.amount);
    if (threshold == null || amount <= 0 || balance >= threshold) continue;
    try {
      // TODO(payments): trigger the actual NACH debit against
      // auto_nach_mandate_ref. Until that integration lands, record the credit
      // so the prepaid balance and ledger stay consistent.
      await postTopup({
        tenantId: w.tenant_id,
        amount,
        description: `Auto-NACH recharge (balance ${balance} < threshold ${threshold})`,
      });
      recharged += 1;
    } catch (e) {
      console.error("[origination-maintenance] auto-NACH recharge failed for", w.tenant_id, e);
    }
  }

  return { nudged, stale_flagged: staleResult.length, fi_sla_breached: fiResult.length, recharged };
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  const summary = await run();
  return NextResponse.json({ ok: true, ...summary });
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  const summary = await run();
  return NextResponse.json({ ok: true, ...summary });
}
