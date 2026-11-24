// 24 Nov (CRM item 4 + the 24 Nov tree): a visit is not recorded without the
// lead's Type of Business, and — when that type is Battery Sale — at least one
// Segment (what the dealer sells). Shared by POST /api/asm/lead/[id]/visit and
// the WhatsApp Assistant's log_visit / set_follow_up so they refuse, and save,
// the same way.
//
// A visit may carry a type and / or segments; whatever it carries is written to
// dealer_leads in the visit's own transaction. What it leaves out comes from
// the lead. Read through to_jsonb so a DB without E-296 answers "not set".

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isBusinessType, type BusinessType } from "@/lib/leads/businessType";
import { parseSegments, storedSegments, type LeadSegment } from "@/lib/leads/segments";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<Tx, "execute">;

export const VISIT_BUSINESS_TYPE_REQUIRED = "Pick the lead's type of business before saving the visit.";
export const VISIT_SEGMENT_REQUIRED = "Pick at least one segment (what the dealer sells) for a battery sale.";

export type LeadTypeState = { business_type: string | null; segments: string[] };
export type VisitTypeInput = { business_type?: string | null; segments?: readonly string[] | null };

export type VisitTypePlan =
    | { ok: false; missing: "type" | "segment"; message: string }
    | { ok: true; writeType: BusinessType | null; writeSegments: LeadSegment[] | null; type: BusinessType; segments: string[] };

/** Pure: what the visit needs to do about type + segments. */
export function planVisitBusinessType(given: VisitTypeInput, current: LeadTypeState): VisitTypePlan {
    const type = isBusinessType(given.business_type)
        ? given.business_type
        : isBusinessType(current.business_type)
          ? current.business_type
          : null;
    if (!type) return { ok: false, missing: "type", message: VISIT_BUSINESS_TYPE_REQUIRED };

    const givenSegs = given.segments && given.segments.length ? parseSegments(given.segments) : null;
    const segments = givenSegs ?? storedSegments(current.segments);
    if (type === "battery_sale" && segments.length === 0) {
        return { ok: false, missing: "segment", message: VISIT_SEGMENT_REQUIRED };
    }
    const curSegs = storedSegments(current.segments);
    const sameSegs = givenSegs && givenSegs.length === curSegs.length && givenSegs.every((s) => curSegs.includes(s));
    return {
        ok: true,
        type,
        segments,
        writeType: type !== current.business_type ? type : null,
        writeSegments: givenSegs && !sameSegs ? givenSegs : null,
    };
}

/** The lead's stored type + segments (type null before E-296). */
export async function currentLeadType(leadId: string, exec: Exec = db): Promise<LeadTypeState> {
    const rows = (await exec.execute(sql`
        SELECT to_jsonb(dl) ->> 'business_type' AS business_type,
               COALESCE(dl.segments, '[]'::jsonb) AS segments
          FROM dealer_leads dl WHERE dl.id = ${leadId}
    `)) as unknown as Array<{ business_type: string | null; segments: unknown }>;
    const r = rows[0];
    return { business_type: r?.business_type ?? null, segments: storedSegments(r?.segments) };
}

/** Thrown when a visit cannot be saved for want of a type / segment (422). */
export class VisitBusinessTypeError extends Error {
    readonly status = 422;
}

/** Check + write in one go, inside the visit's transaction. */
export async function applyVisitBusinessType(tx: Exec, leadId: string, given: VisitTypeInput): Promise<void> {
    const plan = planVisitBusinessType(given, await currentLeadType(leadId, tx));
    if (!plan.ok) throw new VisitBusinessTypeError(plan.message);
    if (plan.writeType) {
        await tx.execute(sql`UPDATE dealer_leads SET business_type = ${plan.writeType}, updated_at = NOW() WHERE id = ${leadId}`);
    }
    if (plan.writeSegments) {
        await tx.execute(sql`
            UPDATE dealer_leads SET segments = ${JSON.stringify(plan.writeSegments)}::jsonb, updated_at = NOW() WHERE id = ${leadId}
        `);
    }
}
