// B1 (E-361) — remember each lead's phone type, for the "Needs dealer mobile"
// filter on /leads. Written when a campaign is created and by the backfill
// (scripts/_backfill-e361-phone-types.ts).
//
// Raw SQL, not in schema.ts, behind a to_regclass probe: without E-361 the
// dialer still skips landlines (numberHygiene.ts); only the filter is off.
// Nothing here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { PhoneType } from "./numberHygiene";

const PROBE_TTL_MS = 5 * 60 * 1000;
let probe: { at: number; ok: boolean } | null = null;

export async function hasPhoneTypeTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
    try {
        const r = (await db.execute(sql`
            SELECT to_regclass('public.dealer_lead_phone_type') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }> | { rows: Array<{ ok: boolean }> };
        const list = Array.isArray(r) ? r : r.rows;
        probe = { at: Date.now(), ok: !!list?.[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

export type PhoneTypeRow = { leadId: string; phone: string; phoneType: PhoneType };

/** Upsert phone types. Returns how many rows were written (0 without E-361). */
export async function recordPhoneTypes(rows: PhoneTypeRow[]): Promise<number> {
    const usable = rows.filter((r) => r.phone?.trim());
    if (usable.length === 0 || !(await hasPhoneTypeTable())) return 0;
    let written = 0;
    const CHUNK = 500;
    try {
        for (let i = 0; i < usable.length; i += CHUNK) {
            const values = usable
                .slice(i, i + CHUNK)
                .map((r) => sql`(${r.leadId}, ${r.phone}, ${r.phoneType}, now())`);
            await db.execute(sql`
                INSERT INTO dealer_lead_phone_type (lead_id, phone, phone_type, checked_at)
                VALUES ${sql.join(values, sql`, `)}
                ON CONFLICT (lead_id) DO UPDATE
                   SET phone = EXCLUDED.phone,
                       phone_type = EXCLUDED.phone_type,
                       checked_at = EXCLUDED.checked_at
            `);
            written += Math.min(CHUNK, usable.length - i);
        }
    } catch (err) {
        console.error(
            "[phoneTypeStore.recordPhoneTypes] failed:",
            err instanceof Error ? err.message : err,
        );
    }
    return written;
}

/**
 * The /leads "Needs dealer mobile" predicate over `dl` (dealer_leads): no phone
 * at all, or a number typed as not a mobile. Only a row computed for the lead's
 * CURRENT number counts.
 */
export const NEEDS_DEALER_MOBILE_SQL = sql`(
    coalesce(btrim(dl.phone), '') = ''
    OR EXISTS (
        SELECT 1 FROM dealer_lead_phone_type pt
         WHERE pt.lead_id = dl.id
           AND pt.phone = dl.phone
           AND pt.phone_type NOT IN ('mobile', 'fixed_or_mobile')
    )
)`;
