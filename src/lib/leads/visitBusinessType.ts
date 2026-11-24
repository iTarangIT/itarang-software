// 24 Nov (CRM item 4): a visit is not recorded without the lead's Type of
// Business. Shared by POST /api/asm/lead/[id]/visit and the WhatsApp
// Assistant's log_visit so both refuse — and both save the type — the same way.
//
// The rule: the visit may carry a business type (it is then written to
// dealer_leads.business_type in the visit's own transaction); without one, the
// lead must already have one. The column is read through to_jsonb so a
// database without E-296 answers "not set" instead of erroring.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isBusinessType, type BusinessType } from "@/lib/leads/businessType";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<Tx, "execute">;

export const VISIT_BUSINESS_TYPE_REQUIRED = "Pick the lead's type of business before saving the visit.";

/** Pure: what the visit needs to do about the business type. */
export function planVisitBusinessType(
    given: string | null | undefined,
    current: string | null | undefined,
): { ok: false; message: string } | { ok: true; write: BusinessType | null } {
    if (isBusinessType(given)) return { ok: true, write: given === current ? null : given };
    if (isBusinessType(current)) return { ok: true, write: null };
    return { ok: false, message: VISIT_BUSINESS_TYPE_REQUIRED };
}

/** The lead's stored business type, or null (also null before E-296). */
export async function currentBusinessType(leadId: string, exec: Exec = db): Promise<string | null> {
    const rows = (await exec.execute(sql`
        SELECT to_jsonb(dl) ->> 'business_type' AS business_type FROM dealer_leads dl WHERE dl.id = ${leadId}
    `)) as unknown as Array<{ business_type: string | null }>;
    return rows[0]?.business_type ?? null;
}

/** Writes a business type chosen with the visit (inside the visit's transaction). */
export async function saveVisitBusinessType(tx: Exec, leadId: string, type: BusinessType): Promise<void> {
    await tx.execute(sql`
        UPDATE dealer_leads SET business_type = ${type}, updated_at = NOW() WHERE id = ${leadId}
    `);
}

/** Thrown when a visit comes without a business type on a lead that has none (422). */
export class VisitBusinessTypeError extends Error {
    readonly status = 422;
    constructor(message = VISIT_BUSINESS_TYPE_REQUIRED) {
        super(message);
    }
}

/**
 * Check + write in one go, inside the visit's transaction. Throws
 * VisitBusinessTypeError when the visit cannot be saved.
 */
export async function applyVisitBusinessType(
    tx: Exec,
    leadId: string,
    given: string | null | undefined,
): Promise<void> {
    const plan = planVisitBusinessType(given, await currentBusinessType(leadId, tx));
    if (!plan.ok) throw new VisitBusinessTypeError(plan.message);
    if (plan.write) await saveVisitBusinessType(tx, leadId, plan.write);
}
