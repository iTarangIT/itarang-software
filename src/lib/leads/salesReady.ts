// The Sales-ready event (tracker ID 82, handover P2-10, 29 Sep 2026).
//
// A lead is SALES-READY from a dated event with a reason — not from its
// creation date. The "awaiting assignment" clock starts here, and "Ready to
// assign" lists sales-ready leads nobody owns. First event wins: the date and
// reason are never moved by a later one.
//
// Written through a SAVEPOINT (E-314 columns, not in schema.ts): a DB without
// E-314 loses the event and nothing else.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SALES_READY_REASONS = [
    "ai_qualified",
    "rep_created",
    "claimed_by_rep",
    "neodove_pickup",
    "inbound_inquiry",
    "admin_marked",
] as const;
export type SalesReadyReason = (typeof SALES_READY_REASONS)[number];

const LABEL: Record<SalesReadyReason, string> = {
    ai_qualified: "qualified by the AI call",
    rep_created: "created by a rep",
    claimed_by_rep: "claimed by a rep",
    neodove_pickup: "picked up by a NeoDove agent",
    inbound_inquiry: "inbound inquiry",
    admin_marked: "marked by admin",
};

export async function markSalesReady(
    exec: Tx | typeof db,
    input: { leadId: string; reason: SalesReadyReason; actorId: string | null; at?: Date },
): Promise<boolean> {
    const at = (input.at ?? new Date()).toISOString();
    try {
        let stamped = false;
        await exec.transaction(async (sp) => {
            const r = (await sp.execute<{ id: string }>(sql`
                UPDATE dealer_leads
                   SET sales_ready_at = ${at}::timestamptz, sales_ready_reason = ${input.reason}
                 WHERE id = ${input.leadId} AND sales_ready_at IS NULL
                RETURNING id
            `)) as unknown as Array<{ id: string }>;
            if (!r[0]) return;
            stamped = true;
            await writeTouchpoint(
                {
                    dealerLeadId: input.leadId,
                    touchpointType: "sales_ready",
                    performedBy: input.actorId,
                    performedAt: new Date(at),
                    remarks: `Sales-ready — ${LABEL[input.reason]}.`,
                    syncMethod: input.actorId ? "manual" : "system",
                },
                { tx: sp },
            );
        });
        return stamped;
    } catch (e) {
        console.warn("[salesReady] not recorded (E-314 applied?):", e instanceof Error ? e.message : e);
        return false;
    }
}

/** Ready to assign: sales-ready, open, nobody owns it, number not dead. Oldest wait first. */
export async function listReadyToAssign(limit = 200) {
    try {
        return (await db.execute<{
            id: string;
            dealer_name: string | null;
            city: string | null;
            state: string | null;
            lead_status: string | null;
            interest_level: string | null;
            sales_ready_at: string;
            sales_ready_reason: string | null;
            days_waiting: number;
        }>(sql`
            SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.city, dl.state,
                   dl.lead_status, dl.interest_level,
                   dl.sales_ready_at::text AS sales_ready_at, dl.sales_ready_reason,
                   FLOOR(EXTRACT(EPOCH FROM (now() - dl.sales_ready_at)) / 86400)::int AS days_waiting
              FROM dealer_leads dl
             WHERE dl.sales_ready_at IS NOT NULL
               AND dl.current_owner_id IS NULL
               AND dl.is_active IS NOT FALSE
               AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
               AND dl.contactability IS NULL
             ORDER BY dl.sales_ready_at ASC
             LIMIT ${limit}
        `)) as unknown as Array<{
            id: string;
            dealer_name: string | null;
            city: string | null;
            state: string | null;
            lead_status: string | null;
            interest_level: string | null;
            sales_ready_at: string;
            sales_ready_reason: string | null;
            days_waiting: number;
        }>;
    } catch (e) {
        console.warn("[salesReady] list failed (E-314 applied?):", e instanceof Error ? e.message : e);
        return [];
    }
}
