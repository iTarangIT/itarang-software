// Lead bell notices (12 Oct) — whenever a lead moves to someone, or needs
// someone to act, that person is told, and the bell row opens the lead on
// THEIR page: an ASM's /asm/lead/[id], everyone else's /inside-sales/lead/[id]
// (the page that admits ISR, partner and the managers).
//
//   notifyLeadsReassigned   reassign (Leads page, owner's own, Assistant)
//   notifyLeadsReturned     a reactivated lead back with its person
//   notifyLeadPerson        one person, one lead, any message (visit done,
//                           escalation resolved, deal card changed, …)
//
// Run AFTER the change is saved; never throws (best-effort). One bell per lead
// up to BULK_NOTICE_LIMIT leads; above that, one summary row that opens the
// person's queue, so a 500-lead bulk move does not bury the bell.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notifications/notify";

export const BULK_NOTICE_LIMIT = 5;

/** Where a lead opens for this role. */
export function leadHrefFor(role: string | null | undefined, leadId: string): string {
    return (role ?? "").toLowerCase() === "asm" ? `/asm/lead/${leadId}` : `/inside-sales/lead/${leadId}`;
}

/** The person's own lead queue, for the bulk summary. */
export function queueHrefFor(role: string | null | undefined): string {
    return (role ?? "").toLowerCase() === "asm" ? "/asm" : "/inside-sales";
}

async function people(ids: string[]): Promise<Map<string, { role: string | null; name: string | null }>> {
    const list = [...new Set(ids.filter(Boolean))];
    if (list.length === 0) return new Map();
    const rows = (await db.execute<{ id: string; role: string | null; name: string | null }>(sql`
        SELECT id::text AS id, role, COALESCE(name, email) AS name FROM users
         WHERE id::text IN (${sql.join(list.map((i) => sql`${i}`), sql`, `)})
    `)) as unknown as Array<{ id: string; role: string | null; name: string | null }>;
    return new Map(rows.map((r) => [r.id, { role: r.role, name: r.name }]));
}

async function leadNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = (await db.execute<{ id: string; dealer: string | null; city: string | null }>(sql`
        SELECT id, COALESCE(shop_name, dealer_name) AS dealer, city FROM dealer_leads
         WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `)) as unknown as Array<{ id: string; dealer: string | null; city: string | null }>;
    return new Map(rows.map((r) => [r.id, `${r.dealer ?? "a lead"}${r.city ? ` (${r.city})` : ""}`]));
}

/** Many leads moved to one person by one actor — one bell each, or one summary. */
async function notifyLeadsMoved(input: {
    leadIds: string[];
    targetUserId: string | null | undefined;
    actorId: string | null | undefined;
    reason?: string | null;
    type: string;
    title: { one: string; many: (n: number) => string };
    verb: string;
}): Promise<void> {
    const ids = [...new Set(input.leadIds.filter(Boolean))];
    if (ids.length === 0 || !input.targetUserId || input.targetUserId === input.actorId) return;
    try {
        const who = await people([input.targetUserId, input.actorId ?? ""]);
        const target = who.get(input.targetUserId);
        const by = (input.actorId && who.get(input.actorId)?.name) || "Your manager";
        const why = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";

        if (ids.length > BULK_NOTICE_LIMIT) {
            await notifyUser(input.targetUserId, {
                type: input.type,
                title: input.title.many(ids.length),
                message: `${by} ${input.verb} ${ids.length} leads to you.${why} Tap to open your queue.`,
                data: { href: queueHrefFor(target?.role), lead_ids: ids.slice(0, 200), by: input.actorId ?? null },
            });
            return;
        }
        const names = await leadNames(ids);
        for (const id of ids) {
            await notifyUser(input.targetUserId, {
                type: input.type,
                title: input.title.one,
                message: `${by} ${input.verb} ${names.get(id) ?? "a lead"} to you.${why} Tap to open the lead.`,
                leadId: id,
                data: { href: leadHrefFor(target?.role, id), by: input.actorId ?? null },
            });
        }
    } catch (err) {
        console.error(`[lead-notice] ${input.type} failed:`, err);
    }
}

/** Reassign: the new owner. */
export async function notifyLeadsReassigned(input: {
    leadIds: string[];
    targetUserId: string;
    actorId: string;
    reason?: string | null;
}): Promise<void> {
    await notifyLeadsMoved({
        ...input,
        type: "lead.reassigned_to_you",
        title: { one: "Lead assigned to you", many: (n) => `${n} leads assigned to you` },
        verb: "reassigned",
    });
}

/** Reactivation / drop-out re-engage: the person the lead went back to. */
export async function notifyLeadsReturned(input: {
    leadIds: string[];
    targetUserId: string | null | undefined;
    actorId: string | null | undefined;
    reason?: string | null;
}): Promise<void> {
    await notifyLeadsMoved({
        ...input,
        type: "lead.reactivated",
        title: { one: "Lead reactivated — back with you", many: (n) => `${n} leads reactivated — back with you` },
        verb: "reactivated and returned",
    });
}

/** One person, one lead: a ready-made title and message; the bell opens the lead. */
export async function notifyLeadPerson(input: {
    userId: string | null | undefined;
    actorId?: string | null;
    leadId: string;
    type: string;
    title: string;
    /** "{by}" is replaced with the actor's name, "{lead}" with the dealer (city). */
    message: string;
}): Promise<void> {
    if (!input.userId || input.userId === input.actorId) return;
    try {
        const who = await people([input.userId, input.actorId ?? ""]);
        const names = await leadNames([input.leadId]);
        const by = (input.actorId && who.get(input.actorId)?.name) || "Someone";
        await notifyUser(input.userId, {
            type: input.type,
            title: input.title,
            message: input.message.split("{by}").join(by).split("{lead}").join(names.get(input.leadId) ?? "a lead"),
            leadId: input.leadId,
            data: { href: leadHrefFor(who.get(input.userId)?.role, input.leadId), by: input.actorId ?? null },
        });
    } catch (err) {
        console.error(`[lead-notice] ${input.type} failed:`, err);
    }
}

/** The person who last handed this lead to the ASM (latest asm_transfer), for visit outcomes. */
export async function lastTransferredBy(leadId: string): Promise<string | null> {
    try {
        const rows = (await db.execute<{ by: string | null }>(sql`
            SELECT performed_by AS by FROM lead_touchpoints
             WHERE dealer_lead_id = ${leadId} AND touchpoint_type = 'asm_transfer' AND performed_by IS NOT NULL
             ORDER BY performed_at DESC LIMIT 1
        `)) as unknown as Array<{ by: string | null }>;
        return rows[0]?.by ?? null;
    } catch {
        return null;
    }
}
