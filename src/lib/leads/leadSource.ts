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
//
// Paths that bring in many leads at once (bulk upload, /leads Import, the
// scraper, AI-dialer lists) use the *Bulk / recordReinquiries helpers: one
// statement for the batch instead of a transaction per lead, and one summary
// notification instead of one per dealer.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { loadExistingByPhone, normalizePhone } from "@/lib/leads/dedupe";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export {
    LEAD_DOORS,
    LEAD_ORIGINS,
    LEAD_ORIGIN_LABEL,
    LEAD_DOOR_LABEL,
    LIST_DEFAULT_ORIGIN,
    SOURCE_LABELS,
    campaignRequired,
    doorLabel,
    originLabel,
    type LeadDoor,
    type LeadOrigin,
} from "./leadSourceVocab";
import { LEAD_DOOR_LABEL, type LeadDoor, type LeadOrigin } from "./leadSourceVocab";

/** A bulk path logs at most one Re-inquiry per lead in this many days. */
export const REINQUIRY_WINDOW_DAYS = 30;

const doorWords = (door: LeadDoor) => door.replace(/_/g, " ");
const idList = (ids: string[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;

async function savepoint(exec: Tx | typeof db, fn: (x: Tx) => Promise<unknown>): Promise<boolean> {
    try {
        await exec.transaction(async (sp) => void (await fn(sp)));
        return true;
    } catch (e) {
        console.warn("[leadSource] not written (E-314 applied?):", e instanceof Error ? e.message : e);
        return false;
    }
}

/**
 * Stamp door / origin / campaign on a lead. The first value of each is kept for
 * good (E-317 also locks it in the database): a returning dealer is a
 * Re-inquiry, never a new source.
 */
export async function stampLeadSource(
    exec: Tx | typeof db,
    leadId: string,
    src: { door: LeadDoor; origin?: LeadOrigin | null; campaignId?: string | null },
): Promise<boolean> {
    return savepoint(exec, (x) =>
        x.execute(sql`
            UPDATE dealer_leads
               SET source_door = COALESCE(source_door, ${src.door}),
                   source_origin = COALESCE(source_origin, ${src.origin ?? null}),
                   acquisition_campaign_id = COALESCE(acquisition_campaign_id, ${src.campaignId ?? null}::uuid)
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
 * Door / origin / campaign on many leads at once — same first-value-wins rule
 * as stampLeadSource. Best-effort: false when the columns are not there.
 */
export async function stampLeadSourceBulk(
    leadIds: string[],
    src: { door: LeadDoor; origin?: LeadOrigin | null; campaignId?: string | null },
): Promise<boolean> {
    if (leadIds.length === 0) return true;
    try {
        await db.execute(sql`
            UPDATE dealer_leads
               SET source_door = COALESCE(source_door, ${src.door}),
                   source_origin = COALESCE(source_origin, ${src.origin ?? null}),
                   acquisition_campaign_id = COALESCE(acquisition_campaign_id, ${src.campaignId ?? null}::uuid)
             WHERE id IN ${idList(leadIds)}
        `);
        return true;
    } catch (e) {
        console.warn("[leadSource] bulk source not written (E-314 applied?):", e instanceof Error ? e.message : e);
        return false;
    }
}

/**
 * "Lead created" on many new leads in one statement. The same line and the
 * same last-activity stamp recordLeadCreated writes, without a transaction per
 * lead — a 5,000-row sheet must not open 5,000 of them. A lead that already
 * has the line is skipped. Never throws: the leads exist either way.
 */
export async function recordLeadsCreatedBulk(
    leadIds: string[],
    input: { door: LeadDoor; actorId: string | null },
): Promise<number> {
    if (leadIds.length === 0) return 0;
    try {
        const rows = await db.execute<{ id: string }>(sql`
            WITH written AS (
                INSERT INTO lead_touchpoints
                    (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method)
                SELECT dl.id, 'lead_created', ${input.actorId}::text, NOW(),
                       ${`Lead created (${doorWords(input.door)}).`},
                       ${input.actorId ? "manual" : "system"}
                  FROM dealer_leads dl
                 WHERE dl.id IN ${idList(leadIds)}
                   AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t
                                    WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'lead_created')
                RETURNING dealer_lead_id
            )
            UPDATE dealer_leads dl
               SET last_touchpoint_at = COALESCE(dl.last_touchpoint_at, NOW())
              FROM written w WHERE dl.id = w.dealer_lead_id
            RETURNING dl.id
        `);
        return (rows as unknown as unknown[]).length;
    } catch (e) {
        console.error('[leadSource] "Lead created" not recorded for the batch:', e instanceof Error ? e.message : e);
        return 0;
    }
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

/**
 * "Re-inquiry" on the lead a returning dealer already has (never a second
 * copy). The lead's owner and the Sales Head are told (ID 81) — the owner is
 * skipped when they are the one who brought the dealer in again.
 */
export async function recordReinquiry(input: ReinquiryInput): Promise<void> {
    try {
        await writeReinquiry(input);
    } catch (e) {
        console.error("[leadSource] re-inquiry not recorded:", e instanceof Error ? e.message : e);
        return;
    }
    await notifyReinquiry(input);
}

type ReinquiryInput = {
    leadId: string;
    door: LeadDoor;
    actorId: string | null;
    note?: string | null;
};

/**
 * The Re-inquiry line alone, optionally inside the caller's transaction — the
 * WhatsApp Assistant writes it only after the rep answers Yes (ID 137), from
 * its executor's transaction. Throws on failure; pair with notifyReinquiry.
 */
export async function writeReinquiry(
    input: ReinquiryInput,
    opts?: Parameters<typeof writeTouchpoint>[1],
): Promise<void> {
    await writeTouchpoint(
        {
            dealerLeadId: input.leadId,
            touchpointType: "lead_reinquiry",
            performedBy: input.actorId,
            remarks: `Re-inquiry via ${doorWords(input.door)}${input.note ? ` — ${input.note}` : ""}.`,
            syncMethod: input.actorId ? "manual" : "system",
        },
        opts,
    );
}

/** Tell the owner and the Sales Head (ID 81). Best-effort — never throws. */
export async function notifyReinquiry(input: ReinquiryInput): Promise<void> {
    try {
        // Loaded here, not at the top: the notification hub pulls in the whole
        // emit stack, which the other callers of this module do not need.
        const { notifyLeadReinquiry } = await import("@/lib/notifications/events");
        await notifyLeadReinquiry({
            leadId: input.leadId,
            via: LEAD_DOOR_LABEL[input.door],
            actorId: input.actorId,
        });
    } catch (e) {
        console.warn("[leadSource] re-inquiry notification failed:", e instanceof Error ? e.message : e);
    }
}

/**
 * Re-inquiries from a path that brings in many dealers at once. One line per
 * lead, at most once per REINQUIRY_WINDOW_DAYS for the same door — a weekly
 * re-scrape of one city, or the same list dialled again, must not write a line
 * on every known dealer every time. The owners and the Sales Head get ONE
 * summary each, not a notification per dealer.
 *
 * Returns how many lines were written. Never throws.
 */
export async function recordReinquiries(
    known: { id: string; note?: string | null }[],
    input: { door: LeadDoor; actorId: string | null; windowDays?: number },
): Promise<number> {
    const notes = new Map<string, string | null>();
    for (const k of known) if (!notes.has(k.id)) notes.set(k.id, k.note?.trim() || null);
    if (notes.size === 0) return 0;

    const via = `Re-inquiry via ${doorWords(input.door)}`;
    let written: { id: string; owner_id: string | null }[] = [];
    try {
        const payload = [...notes].map(([id, note]) => ({ id, note }));
        written = (await db.execute<{ id: string; owner_id: string | null }>(sql`
            WITH incoming AS (
                SELECT x.id, x.note
                  FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(id text, note text)
            ), written AS (
                INSERT INTO lead_touchpoints
                    (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks, sync_method)
                SELECT dl.id, 'lead_reinquiry', ${input.actorId}::text, NOW(),
                       ${via} || COALESCE(' — ' || i.note, '') || '.',
                       ${input.actorId ? "manual" : "system"}
                  FROM incoming i
                  JOIN dealer_leads dl ON dl.id = i.id
                 WHERE NOT EXISTS (
                        SELECT 1 FROM lead_touchpoints t
                         WHERE t.dealer_lead_id = dl.id
                           AND t.touchpoint_type = 'lead_reinquiry'
                           AND t.remarks LIKE ${`${via}%`}
                           AND t.performed_at >= NOW() - make_interval(days => ${input.windowDays ?? REINQUIRY_WINDOW_DAYS}))
                RETURNING dealer_lead_id
            )
            UPDATE dealer_leads dl
               SET last_touchpoint_at = NOW(), updated_at = NOW()
              FROM written w WHERE dl.id = w.dealer_lead_id
            RETURNING dl.id, dl.current_owner_id AS owner_id
        `)) as unknown as { id: string; owner_id: string | null }[];
    } catch (e) {
        console.error("[leadSource] re-inquiries not recorded:", e instanceof Error ? e.message : e);
        return 0;
    }
    if (written.length === 0) return 0;

    try {
        const { notifyLeadReinquiryBatch } = await import("@/lib/notifications/events");
        await notifyLeadReinquiryBatch({
            via: LEAD_DOOR_LABEL[input.door],
            actorId: input.actorId,
            leads: written.map((w) => ({ leadId: w.id, ownerUserId: w.owner_id })),
        });
    } catch (e) {
        console.warn("[leadSource] re-inquiry summary notification failed:", e instanceof Error ? e.message : e);
    }
    return written.length;
}
