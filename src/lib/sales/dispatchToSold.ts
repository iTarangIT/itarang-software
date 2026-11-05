/**
 * Dispatched → delivered (sold) after DISPATCH_TO_SOLD_DAYS (BRD V2 §3.5).
 *
 * A sale whose inventory has been 'dispatched' for longer than the delay is
 * finalised as if the dealer pressed Mark delivered. Used by the cron route
 * (/api/cron/dispatch-to-sold) and, since ID 220, by an in-process daily
 * ticker: vercel.json crons never fire on the PM2 live server.
 *
 * runDailyDispatchToSold claims a digest_runs row per IST day (the Drive
 * 08:30 scan pattern, no migration), so several processes or a restart can
 * never run it twice in a day. Each lead is re-checked under a row lock, so
 * a dealer's own Mark delivered in between is never overwritten.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { deployedAssets, inventory, leads, productSelections } from "@/lib/db/schema";
import { istSlotState, type Slot } from "@/lib/monitor/schedule";
import { deliveredSmsTimely } from "@/lib/sales/dispatchToSoldSchedule";

/** 09:30 IST — the old Vercel schedule (04:00 UTC). */
export const DISPATCH_TO_SOLD_SLOT: Slot = { hour: 9, minute: 30 };
const KIND = "dispatch_to_sold";
const SLOT_NAME = "morning";
const MAX_ATTEMPTS = 6;
const STUCK_CLAIM_MINUTES = 30;

export function dispatchToSoldDays(): number {
    const n = Number(process.env.DISPATCH_TO_SOLD_DAYS ?? "1");
    return Number.isFinite(n) && n > 0 ? n : 1;
}

export type DispatchToSoldResult = {
    dryRun: boolean;
    cutoff: string;
    dispatchToSoldDays: number;
    /** Leads moved (or, on a dry run, that would move). */
    leadsProcessed: string[];
    /** Leads skipped: no battery serial on the latest selection. */
    skippedNoSerial: string[];
    failed: Array<{ leadId: string; error: string }>;
};

export async function runDispatchToSold(opts: { now?: Date; dryRun?: boolean } = {}): Promise<DispatchToSoldResult> {
    const now = opts.now ?? new Date();
    const days = dispatchToSoldDays();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const out: DispatchToSoldResult = {
        dryRun: !!opts.dryRun,
        cutoff: cutoff.toISOString(),
        dispatchToSoldDays: days,
        leadsProcessed: [],
        skippedNoSerial: [],
        failed: [],
    };

    const ripe = await db
        .select({ lead_id: inventory.linked_lead_id, dispatch_date: inventory.dispatch_date })
        .from(inventory)
        .where(and(eq(inventory.status, "dispatched"), lt(inventory.dispatch_date, cutoff)));
    const leadIds = [...new Set(ripe.map((r) => r.lead_id).filter((x): x is string => !!x))];
    // Earliest dispatch per lead, for the customer SMS rule below.
    const dispatchedAt = new Map<string, Date>();
    for (const r of ripe) {
        if (!r.lead_id || !r.dispatch_date) continue;
        const d = new Date(r.dispatch_date);
        const prev = dispatchedAt.get(r.lead_id);
        if (!prev || d < prev) dispatchedAt.set(r.lead_id, d);
    }
    if (leadIds.length === 0) return out;

    const leadRows = await db
        .select()
        .from(leads)
        .where(and(inArray(leads.id, leadIds), eq(leads.kyc_status, "dispatched")));

    for (const lead of leadRows) {
        try {
            // Latest selection: battery + charger flip together.
            const [selection] = await db
                .select()
                .from(productSelections)
                .where(eq(productSelections.lead_id, lead.id))
                .orderBy(desc(productSelections.created_at))
                .limit(1);
            if (!selection?.battery_serial) {
                out.skippedNoSerial.push(lead.id);
                continue;
            }
            if (opts.dryRun) {
                out.leadsProcessed.push(lead.id);
                continue;
            }
            const batterySerial = selection.battery_serial;

            const moved = await db.transaction(async (tx) => {
                const locked = (await tx.execute(
                    sql`SELECT kyc_status FROM leads WHERE id = ${lead.id} FOR UPDATE`,
                )) as unknown as Array<{ kyc_status: string | null }>;
                if (locked[0]?.kyc_status !== "dispatched") return false;
                const { markDispatchedAsSold } = await import("@/lib/sales/sale-finalization");
                await markDispatchedAsSold({
                    tx,
                    leadId: lead.id,
                    batterySerial,
                    chargerSerial: selection.charger_serial ?? null,
                    // As if the dealer pressed Mark delivered: the dealer's
                    // users.id. NOT dealer_id — that is the account id
                    // ("ACC-…"), and inventory_events / deployment_history
                    // .performed_by are uuid columns, so every run failed
                    // with "invalid input syntax for type uuid" (5 Nov).
                    performedBy: lead.uploader_id,
                    soldAt: now,
                });
                await tx.update(leads).set({ kyc_status: "sold", sold_at: now, updated_at: now }).where(eq(leads.id, lead.id));
                return true;
            });
            if (!moved) continue;
            out.leadsProcessed.push(lead.id);
            // ID 220: a "delivery confirmed" SMS weeks after dispatch confuses the
            // customer — the first run after the fix moves a backlog that never
            // moved (every run failed until 5 Nov). The dealer notice always goes.
            await notifyAfterDelivery(lead, batterySerial, deliveredSmsTimely(dispatchedAt.get(lead.id) ?? null, now));
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            out.failed.push({ leadId: lead.id, error });
            console.error(`[dispatch-to-sold] lead ${lead.id} failed:`, error);
        }
    }
    return out;
}

/** After commit, fire-and-forget: the delivered notice and the customer SMS. */
async function notifyAfterDelivery(
    lead: { id: string; phone: string | null; mobile: string | null },
    batterySerial: string,
    smsCustomer: boolean,
): Promise<void> {
    const [asset] = await db
        .select({ id: deployedAssets.id, warranty_end_date: deployedAssets.warranty_end_date })
        .from(deployedAssets)
        .where(eq(deployedAssets.serial_number, batterySerial))
        .limit(1);
    const warrantyId = asset?.id ?? null;
    if (warrantyId) {
        const { notifyDelivered } = await import("@/lib/notifications");
        notifyDelivered({ leadId: lead.id, warrantyId, batterySerial, source: "cron" }).catch(() => {});
    }
    const customerPhone = lead.phone || lead.mobile;
    if (customerPhone && smsCustomer) {
        const warrantyEnd = asset?.warranty_end_date ? new Date(asset.warranty_end_date).toISOString().slice(0, 10) : "—";
        const { sendKycSms } = await import("@/lib/sms");
        sendKycSms({
            mobile_number: customerPhone,
            message: `Welcome to iTarang! Your battery ${batterySerial} delivery is confirmed. Warranty ${warrantyId ?? "—"} valid through ${warrantyEnd}. Reach support: support@itarang.com`,
            reference_id: `cron-delivered-${lead.id}-${Date.now()}`,
        }).catch(() => {});
    }
}

// ── Once a day (ID 220) ─────────────────────────────────────────────────────

async function claim(istDate: string): Promise<number | null> {
    const rows = (await db.execute(sql`
        INSERT INTO digest_runs (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
        VALUES (${KIND}, ${istDate}::date, ${SLOT_NAME}, 'sending', 1, 'ticker', 'system', now())
        ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening')
        DO UPDATE SET status = 'sending', attempts = digest_runs.attempts + 1, claimed_at = now()
        WHERE (digest_runs.status = 'failed' AND digest_runs.attempts < ${MAX_ATTEMPTS})
           OR (digest_runs.status = 'sending'
               AND digest_runs.claimed_at < now() - make_interval(mins => ${STUCK_CLAIM_MINUTES}))
        RETURNING id
    `)) as unknown as Array<{ id: number }>;
    return rows?.[0]?.id ?? null;
}

export type DailyDispatchToSoldOutcome =
    | { ran: false; reason: "not_due" | "already_claimed" }
    | { ran: true; istDate: string; moved: number; failed: number };

/** One claimed run per IST day from 09:30; a no-op otherwise. */
export async function runDailyDispatchToSold(now: Date = new Date()): Promise<DailyDispatchToSoldOutcome> {
    const state = istSlotState(now, DISPATCH_TO_SOLD_SLOT);
    if (!state.due) return { ran: false, reason: "not_due" };
    const runId = await claim(state.istDate);
    if (runId === null) return { ran: false, reason: "already_claimed" };
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    let counts: object = {};
    try {
        const r = await runDispatchToSold({ now });
        counts = { moved: r.leadsProcessed.length, skipped_no_serial: r.skippedNoSerial.length, failed: r.failed.length };
        // A sale that failed is a failed day (Ops Console > Jobs shows it red, with
        // the reason) and a later tick retries it; moved sales are no longer
        // 'dispatched', so a retry never moves one twice.
        if (r.failed.length > 0) {
            status = "failed";
            error = r.failed
                .slice(0, 3)
                .map((f) => `${f.leadId}: ${f.error.slice(0, 150)}`)
                .join("; ");
        }
        return { ran: true, istDate: state.istDate, moved: r.leadsProcessed.length, failed: r.failed.length };
    } catch (err) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        throw err;
    } finally {
        await db
            .execute(
                sql`UPDATE digest_runs SET status = ${status}, error = ${error}, counts = ${JSON.stringify(counts)}::jsonb WHERE id = ${runId}`,
            )
            .catch((e: unknown) => console.error("[dispatch-to-sold] outcome not recorded:", e instanceof Error ? e.message : e));
    }
}
