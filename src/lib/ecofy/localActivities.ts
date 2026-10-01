// E-308 — the CRM keeps an ASM / ISR's calls, remarks, follow-ups and meeting
// bookings when Ecofy cannot take them, and replays them later.
//
// Only these two action kinds are kept locally: they are records of work the
// rep already did. Stage moves (advance, assessment, offer, OTP, close …) are
// decisions Ecofy owns and gates, so they still need Ecofy to be reachable.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeadActivities, ecofyLeads } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import type { EcofyActionInput } from "./actionSchemas";
import { EcofyCallError, refreshLeadFromEcofy, runEcofyAction } from "./service";

export type LocalKind = "activity" | "appointment";

/** Actions that may be saved in the CRM when Ecofy is unavailable. */
export function localKindFor(input: EcofyActionInput): LocalKind | null {
    if (input.action === "log_activity") return "activity";
    if (input.action === "book_appointment") return "appointment";
    return null;
}

/**
 * Ecofy could not take the call for reasons that are not about the data:
 * unreachable, server error, or it refused the integration user (401 / 403).
 * A 409 gate or 422 validation error is about the data and is NOT this.
 */
export function isEcofyUnavailable(err: unknown): boolean {
    if (!(err instanceof EcofyCallError)) return false;
    return err.status === 401 || err.status === 403 || err.status >= 500;
}

export async function saveLocalActivity(p: {
    leadId: string;
    kind: LocalKind;
    payload: EcofyActionInput;
    actorId: string;
    actorName: string;
    error: string;
}): Promise<string> {
    const [row] = await db
        .insert(ecofyLeadActivities)
        .values({
            ecofy_lead_id: p.leadId,
            kind: p.kind,
            payload: p.payload,
            created_by: p.actorId,
            created_by_name: p.actorName,
            sync_error: p.error.slice(0, 500),
        })
        .returning({ id: ecofyLeadActivities.id });
    return row.id;
}

export interface LocalActivityRow {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    created_by_name: string | null;
    created_at: string;
    sync_status: string;
    sync_error: string | null;
    synced_at: string | null;
}

/** Everything the CRM recorded for a lead, newest first. */
export async function listLocalActivities(leadId: string): Promise<LocalActivityRow[]> {
    const rows = await db
        .select()
        .from(ecofyLeadActivities)
        .where(eq(ecofyLeadActivities.ecofy_lead_id, leadId))
        .orderBy(desc(ecofyLeadActivities.created_at))
        .limit(200);
    return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        created_by_name: r.created_by_name,
        created_at: r.created_at.toISOString(),
        sync_status: r.sync_status,
        sync_error: r.sync_error,
        synced_at: r.synced_at?.toISOString() ?? null,
    }));
}

/**
 * Replay pending entries to Ecofy, oldest first (the ticker calls this).
 * Stops at the first "Ecofy unavailable" answer: if Ecofy is down or still
 * refusing the integration user, trying the rest now would only repeat it.
 */
export async function syncPendingEcofyActivities(limit = 25): Promise<{ synced: number; failed: number; waiting: boolean }> {
    const pending = await db
        .select({ row: ecofyLeadActivities, ecofy_case_id: ecofyLeads.ecofy_case_id })
        .from(ecofyLeadActivities)
        .innerJoin(ecofyLeads, eq(ecofyLeads.id, ecofyLeadActivities.ecofy_lead_id))
        .where(eq(ecofyLeadActivities.sync_status, "pending"))
        .orderBy(asc(ecofyLeadActivities.created_at))
        .limit(limit);

    let synced = 0;
    let failed = 0;
    for (const { row, ecofy_case_id } of pending) {
        const lead = { id: row.ecofy_lead_id, ecofy_case_id };
        try {
            await runEcofyAction(lead, row.payload as EcofyActionInput, row.created_by_name ?? "CRM user");
            await db
                .update(ecofyLeadActivities)
                .set({
                    sync_status: "synced",
                    synced_at: new Date(),
                    last_attempt_at: new Date(),
                    sync_attempts: sql`${ecofyLeadActivities.sync_attempts} + 1`,
                    sync_error: null,
                })
                .where(eq(ecofyLeadActivities.id, row.id));
            await refreshLeadFromEcofy(lead);
            synced++;
        } catch (err) {
            const unavailable = isEcofyUnavailable(err);
            await db
                .update(ecofyLeadActivities)
                .set({
                    sync_status: unavailable ? "pending" : "failed",
                    last_attempt_at: new Date(),
                    sync_attempts: sql`${ecofyLeadActivities.sync_attempts} + 1`,
                    sync_error: errorMessage(err).slice(0, 500),
                })
                .where(and(eq(ecofyLeadActivities.id, row.id), eq(ecofyLeadActivities.sync_status, "pending")));
            if (unavailable) return { synced, failed, waiting: true };
            failed++;
        }
    }
    return { synced, failed, waiting: false };
}
