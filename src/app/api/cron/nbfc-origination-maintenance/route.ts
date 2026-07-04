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
import { getWalletFundsProvider } from "@/lib/nbfc/wallet/provider";

/** §16.3 lockout: once an auto-recharge fires, no re-fire for this many hours. */
const WALLET_AUTORECHARGE_LOCKOUT_HOURS = Number(process.env.WALLET_AUTORECHARGE_LOCKOUT_HOURS ?? 6);

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

  // 4. Auto-NACH wallet recharge (§16.1 / §16.4 capability 3). For wallets that
  //    opted into auto-NACH, have a REGISTERED creditor-side mandate, and have
  //    fallen below their threshold, fire one debit against the mandate token
  //    via the WalletFundsProvider. The wallet is credited only when the matching
  //    inflow webhook arrives — NOT here — so we do not postTopup. §16.3 controls:
  //    a registered-mandate health check, and a lockout window so a fired
  //    recharge cannot re-fire for N hours regardless of balance.
  const lockoutCutoff = new Date(now - WALLET_AUTORECHARGE_LOCKOUT_HOURS * 60 * 60 * 1000);
  const autoWallets = await db
    .select({
      id: nbfcWallets.id,
      tenant_id: nbfcWallets.tenant_id,
      balance: nbfcWallets.balance,
      threshold: nbfcWallets.auto_nach_threshold,
      amount: nbfcWallets.auto_nach_recharge_amount,
      status: nbfcWallets.auto_nach_status,
      customer_id: nbfcWallets.auto_nach_customer_id,
      token_id: nbfcWallets.auto_nach_token_id,
      last_fired_at: nbfcWallets.auto_nach_last_fired_at,
    })
    .from(nbfcWallets)
    .where(eq(nbfcWallets.auto_nach_enabled, true));

  let recharged = 0;
  let recharge_failed = 0;
  const provider = await getWalletFundsProvider();
  for (const w of autoWallets) {
    const balance = Number(w.balance ?? 0);
    const threshold = w.threshold == null ? null : Number(w.threshold);
    const amount = w.amount == null ? 0 : Number(w.amount);
    if (threshold == null || amount <= 0 || balance >= threshold) continue;
    // §16.3 mandate health check — only fire a registered mandate with a token.
    if (w.status !== "registered" || !w.token_id || !w.customer_id) continue;
    // §16.3 lockout window — skip if a recharge fired within the lockout period.
    if (w.last_fired_at && w.last_fired_at > lockoutCutoff) continue;

    // Idempotency key: stable per (tenant, day, threshold) so a retried tick
    // reuses the same correlation and the inflow credit stays idempotent.
    const day = new Date(now).toISOString().slice(0, 10);
    const idempotencyKey = `${w.tenant_id}|${day}|${threshold}`;
    try {
      const res = await provider.executeAutoRechargeDebit({
        tenantId: w.tenant_id,
        providerMandateRef: `${w.customer_id}|${w.token_id}`,
        amount: Math.round(amount * 100), // rupees → paise
        idempotencyKey,
        description: `Auto-recharge (balance ${balance} < threshold ${threshold})`,
      });
      // Mark fired regardless of submitted/failed — a fire attempt opens the
      // lockout so a stuck mandate is not hammered every tick.
      await db
        .update(nbfcWallets)
        .set({ auto_nach_last_fired_at: new Date(), updated_at: new Date() })
        .where(eq(nbfcWallets.id, w.id));
      if (res.status === "failed") {
        recharge_failed += 1;
        // §16.3 failure alert. A dedicated NBFC-admin + iTarang-admin notification
        // belongs to the §16.5 notification surface (deferred); logged loudly here.
        console.error(
          "[origination-maintenance] AUTO-RECHARGE FAILED for tenant",
          w.tenant_id,
          "reason:",
          res.rawStatus,
        );
      } else {
        recharged += 1;
      }
    } catch (e) {
      recharge_failed += 1;
      console.error("[origination-maintenance] auto-recharge debit threw for", w.tenant_id, e);
    }
  }

  return {
    nudged,
    stale_flagged: staleResult.length,
    fi_sla_breached: fiResult.length,
    recharged,
    recharge_failed,
  };
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
