// Source on every lead (tracker ID 81, handover P2-9, 29 Sep 2026).
//
//   door      HOW the lead entered the CRM — set automatically by the code path
//             that created it, never typed.
//   origin    WHERE the dealer came from — a fixed list.
//   campaign  an ACQUISITION campaign (acquisition_campaigns, E-314) — separate
//             from dialler campaigns (dialer_campaigns / neodove_campaigns).
//
// Every creation path also logs a "Lead created" event, and a known dealer
// arriving again (the shared duplicate check, dedupe.ts) logs a "Re-inquiry"
// on the existing lead instead of a second copy.
//
// The columns are E-314 and not in schema.ts: writes run under a SAVEPOINT in
// a caller's transaction, so a DB without E-314 loses the stamp and nothing else.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { loadExistingByPhone, normalizePhone } from "@/lib/leads/dedupe";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export {
    LEAD_DOORS,
    LEAD_ORIGINS,
    LEAD_ORIGIN_LABEL,
    type LeadDoor,
    type LeadOrigin,
} from "./leadSourceVocab";
import type { LeadDoor, LeadOrigin } from "./leadSourceVocab";

async function savepoint(exec: Tx | typeof db, fn: (x: Tx) => Promise<unknown>): Promise<boolean> {
    try {
        await exec.transaction(async (sp) => void (await fn(sp)));
        return true;
    } catch (e) {
        console.warn("[leadSource] not written (E-314 applied?):", e instanceof Error ? e.message : e);
        return false;
    }
}

/** Stamp door / origin / campaign on a lead. Never overwrites an existing door. */
export async function stampLeadSource(
    exec: Tx | typeof db,
    leadId: string,
    src: { door: LeadDoor; origin?: LeadOrigin | null; campaignId?: string | null },
): Promise<boolean> {
    return savepoint(exec, (x) =>
        x.execute(sql`
            UPDATE dealer_leads
               SET source_door = COALESCE(source_door, ${src.door}),
                   source_origin = COALESCE(${src.origin ?? null}, source_origin),
                   acquisition_campaign_id = COALESCE(${src.campaignId ?? null}::uuid, acquisition_campaign_id)
             WHERE id = ${leadId}
        `),
    );
}

/** "Lead created" — with the ownership hop when the creator keeps the lead (ID 83). */
export async function recordLeadCreated(
    exec: Tx | typeof db,
    input: { leadId: string; actorId: string | null; door: LeadDoor; ownerId: string | null },
): Promise<void> {
    const write = (tx: Tx) =>
        writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "lead_created",
                performedBy: input.actorId,
                remarks: `Lead created (${input.door.replace(/_/g, " ")})${input.ownerId ? " — kept by the creator" : ""}.`,
                syncMethod: input.actorId ? "manual" : "system",
                ...(input.ownerId ? { fromOwnerId: null, toOwnerId: input.ownerId } : {}),
            },
            { tx },
        );
    if (exec === db) await db.transaction(write);
    else await write(exec as Tx);
}

/**
 * The SHARED duplicate check for a single phone (ID 81): the lead that already
 * has this number, matched on the last 10 digits like every upload path.
 */
export async function findExistingLeadByPhone(phone: string | null | undefined): Promise<string | null> {
    const n = phone ? normalizePhone(phone) : null;
    if (!n) return null;
    const existing = (await loadExistingByPhone([n])).get(n);
    return existing?.id ?? null;
}

/** "Re-inquiry" on the lead a returning dealer already has (never a second copy). */
export async function recordReinquiry(input: {
    leadId: string;
    door: LeadDoor;
    actorId: string | null;
    note?: string | null;
}): Promise<void> {
    try {
        await writeTouchpoint({
            dealerLeadId: input.leadId,
            touchpointType: "lead_reinquiry",
            performedBy: input.actorId,
            remarks: `Re-inquiry via ${input.door.replace(/_/g, " ")}${input.note ? ` — ${input.note}` : ""}.`,
            syncMethod: input.actorId ? "manual" : "system",
        });
    } catch (e) {
        console.error("[leadSource] re-inquiry not recorded:", e instanceof Error ? e.message : e);
    }
}
