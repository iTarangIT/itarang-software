// B1 (E-361) — remember each lead's phone type, for the "Needs dealer mobile"
// filter on /leads. Written when a campaign is created and by the backfill
// (scripts/_backfill-e361-phone-types.ts).
//
// Raw SQL, not in schema.ts, behind a to_regclass probe: without E-361 the
// dialer still skips landlines (numberHygiene.ts); only the filter is off.
// Nothing here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { classifyPhone, OBSERVED_PHONE_TYPES, phoneKey, type PhoneType } from "./numberHygiene";
import { deriveFailureReason } from "./failureReason";

const OBSERVED_SQL = sql.raw(OBSERVED_PHONE_TYPES.map((t) => `'${t}'`).join(", "));

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
                 -- A switchboard / dead number a call found stays, unless the
                 -- lead's number has changed since.
                 WHERE NOT (dealer_lead_phone_type.phone = EXCLUDED.phone
                            AND dealer_lead_phone_type.phone_type IN (${OBSERVED_SQL}))
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
 * D2 / D7 — what one finished call teaches us about the NUMBER. A switchboard,
 * or a carrier "does not exist" / SIP 404, marks it (shown under Needs dealer
 * mobile, skipped by later campaigns). A person answering — a later attempt
 * reached a human — clears the mark back to the number's own type.
 */
export async function noteCallResultForNumber(
    leadId: string,
    status: string,
    outcome: string | null,
): Promise<void> {
    const observed =
        status === "switchboard"
            ? "switchboard"
            : status === "failed" &&
                deriveFailureReason({ status, callOutcome: outcome })?.code === "invalid_number"
              ? "dead_number"
              : null;
    if (!observed && status !== "completed") return;
    if (!(await hasPhoneTypeTable())) return;
    try {
        if (observed) {
            await db.execute(sql`
                INSERT INTO dealer_lead_phone_type (lead_id, phone, phone_type, checked_at)
                SELECT id, phone, ${observed}, now() FROM dealer_leads
                 WHERE id = ${leadId} AND coalesce(btrim(phone), '') <> ''
                ON CONFLICT (lead_id) DO UPDATE
                   SET phone = EXCLUDED.phone,
                       phone_type = EXCLUDED.phone_type,
                       checked_at = EXCLUDED.checked_at
            `);
            return;
        }
        const r = (await db.execute(sql`
            SELECT pt.phone FROM dealer_lead_phone_type pt
             WHERE pt.lead_id = ${leadId} AND pt.phone_type IN (${OBSERVED_SQL})
        `)) as unknown as Array<{ phone: string }> | { rows: Array<{ phone: string }> };
        const row = (Array.isArray(r) ? r : r.rows)?.[0];
        if (!row) return;
        await db.execute(sql`
            UPDATE dealer_lead_phone_type
               SET phone_type = ${classifyPhone(row.phone)}, checked_at = now()
             WHERE lead_id = ${leadId}
        `);
    } catch (err) {
        console.error(
            "[phoneTypeStore.noteCallResultForNumber] failed:",
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * D7 — numbers (last 10 digits) a call has marked switchboard / dead, among
 * `phones`. Matched on the number, not the lead: another lead on the same
 * switchboard is the same switchboard.
 */
export async function observedNumbers(
    phones: (string | null)[],
): Promise<Map<string, "switchboard" | "dead_number">> {
    const out = new Map<string, "switchboard" | "dead_number">();
    const keys = [...new Set(phones.map(phoneKey).filter((k): k is string => !!k))];
    if (keys.length === 0 || !(await hasPhoneTypeTable())) return out;
    try {
        const r = (await db.execute(sql`
            SELECT right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) AS key, phone_type
              FROM dealer_lead_phone_type
             WHERE phone_type IN (${OBSERVED_SQL})
               AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) IN (${sql.join(
                   keys.map((k) => sql`${k}`),
                   sql`, `,
               )})
        `)) as unknown as
            | Array<{ key: string; phone_type: "switchboard" | "dead_number" }>
            | { rows: Array<{ key: string; phone_type: "switchboard" | "dead_number" }> };
        for (const row of Array.isArray(r) ? r : r.rows) out.set(row.key, row.phone_type);
    } catch (err) {
        console.error(
            "[phoneTypeStore.observedNumbers] failed:",
            err instanceof Error ? err.message : err,
        );
    }
    return out;
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
