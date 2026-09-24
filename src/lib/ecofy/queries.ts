// Read side of ecofy_leads for the Sales Head "Ecofy Leads" screens (E-305).

import { asc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeads } from "@/lib/db/schema";

export type EcofyLeadRow = typeof ecofyLeads.$inferSelect;

/** Stages that are no longer in the Sales Head's queue: returned to Ecofy, closed. */
export const ECOFY_DONE_STAGES = ["S0", "CLOSED"] as const;

/**
 * Hot first, then the oldest queueEnteredAt (docs/ECOFY_INTEGRATION.md §6,
 * FR-05.1). `open` hides leads returned to Ecofy or closed.
 */
export async function listEcofyLeads(opts: { open: boolean }): Promise<EcofyLeadRow[]> {
    return db
        .select()
        .from(ecofyLeads)
        .where(
            opts.open
                ? or(isNull(ecofyLeads.stage), notInArray(ecofyLeads.stage, [...ECOFY_DONE_STAGES]))
                : undefined,
        )
        .orderBy(
            sql`CASE WHEN ${ecofyLeads.temperature} = 'HOT' THEN 0 ELSE 1 END`,
            sql`${ecofyLeads.queue_entered_at} ASC NULLS LAST`,
            asc(ecofyLeads.created_at),
        )
        .limit(500);
}

export async function getEcofyLead(id: string): Promise<EcofyLeadRow | null> {
    // ids are uuids; anything else cannot match and would make Postgres throw.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await db.select().from(ecofyLeads).where(eq(ecofyLeads.id, id)).limit(1);
    return rows[0] ?? null;
}

/** Only ever link out to an https URL — ecofyUrl arrives from another system. */
export function safeEcofyUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === "https:" ? u.toString() : null;
    } catch {
        return null;
    }
}
