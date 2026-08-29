// The single dedupe engine for the dealer_leads prospect pool (BRD §0.2/§0.4).
//
// WHY THIS MODULE EXISTS. Before E-224 the CRM had four entry paths into the
// prospect pool with four different answers to "is this lead already here":
//
//   * src/lib/admin/csvUpload.ts        — strict phone normalisation, four
//                                         outcomes, in-batch duplicate check.
//                                         The correct one.
//   * src/app/api/leads/import          — lax normalisation, phone match only,
//                                         silent skip on any hit.
//   * src/app/api/dealer-leads (POST)   — NO normalisation at all: stored the
//                                         raw typed string and deduped on it.
//   * src/app/api/leads/check-duplicate — lax normalisation, and pointed at the
//                                         WRONG TABLE (`leads`, the loan entity).
//
// The disagreements were real, not cosmetic. `9876543210` normalises the same
// way everywhere, but `05512345678` (11-digit, leading zero) is +915512345678
// under the lax rules and REJECTED under the strict one. Worse, the single-lead
// route stored whatever was typed — so "98765 43210" and "+919876543210" were
// two different dealers to it, and a lead created that way could never again be
// matched by any importer, all of which normalise.
//
// Now every entry path — bulk wizard, /leads Import, single-lead modal,
// AI-dialer list upload, and NeoDove inbound — classifies through this module,
// so the answer is the same regardless of which door the lead came in.
//
// THE FOUR OUTCOMES (BRD §0.4). Matching on phone alone is deliberate: it is
// the only field both reliably present and reliably typed the same way. `city`
// is NOT part of the key — it is a tie-breaker deciding what to DO with a phone
// match, because the same dealer at a new address is a real event that must not
// be silently merged nor silently duplicated.
//
//   valid            — no existing lead. Insert.
//   reactivate       — existing lead is Lost. Revive it (BRD §0.9) rather than
//                      inserting a second row; dealer_leads.phone is UNIQUE so
//                      the insert would fail anyway.
//   address_mismatch — existing lead is open but sits in a different city.
//                      Neither system can decide which is right, so it goes to
//                      duplicate_merge_requests for a human.
//   duplicate_skip   — existing open lead, same city. Skip.
//
// The pure classification lives in ./dedupe-rules (no imports, unit-tested);
// this module adds the DB-backed lookup and re-exports the rules so callers
// only ever import from here.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    classifyAgainstExisting,
    normalizePhone,
    type DedupClassification,
    type ExistingLead,
} from "./dedupe-rules";

export {
    classifyAgainstExisting,
    normalizePhone,
    type DedupClassification,
    type DedupOutcome,
    type ExistingLead,
} from "./dedupe-rules";

/**
 * Load every dealer_lead matching any of the given normalised phones, keyed by
 * phone.
 *
 * One query for the whole batch. The route this replaced ran a SELECT per row,
 * which on a 5000-row sheet is 5000 round-trips — slow enough that the request
 * timed out well before the insert phase and the operator retried, compounding
 * the problem.
 */
export async function loadExistingByPhone(
    phones: string[],
): Promise<Map<string, ExistingLead>> {
    const unique = [...new Set(phones.filter(Boolean))];
    if (unique.length === 0) return new Map();

    // MATCH ON THE LAST 10 DIGITS, not on the string.
    //
    // This used to be `WHERE phone IN (<normalised>)` — an exact text compare
    // against dealer_leads.phone. dealer_leads.phone is NOT uniformly
    // normalised: `dealer_leads_phone_key` is unique on the raw text, so
    // `8269342343` and `+918269342343` are two different keys and BOTH get in.
    // An exact compare therefore missed every lead stored in the other format,
    // reported "no duplicate", and inserted a second copy of a dealer we already
    // had.
    //
    // Observed live on 2026-08-03: L-7VOPwrpR (phone `8269342343`, created
    // 2026-07-20, complete record) was pushed to NeoDove; NeoDove echoed a
    // LEAD_CREATE back one second later; this lookup did not match it, and
    // DL-1785765523015-185a5a73 (phone `+918269342343`, no shop_name, no city)
    // was created as a duplicate. Every NeoDove round-trip did this.
    //
    // The digits idiom is the one already used by /leads/[id] to attribute
    // ai_call_logs rows, and the jsonb-array parameter form is the one used by
    // resolveAudience() — both deliberately, so there is one way to do this.
    const byLast10 = new Map<string, string>();
    for (const p of unique) {
        const digits = p.replace(/\D/g, "").slice(-10);
        if (digits.length === 10) byLast10.set(digits, p);
    }
    if (byLast10.size === 0) return new Map();

    const rows = (await db.execute<ExistingLead & { match_digits: string }>(sql`
        SELECT id, phone, lead_status, city, state,
               right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) AS match_digits
        FROM dealer_leads
        WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) IN (
            SELECT jsonb_array_elements_text(${JSON.stringify([...byLast10.keys()])}::jsonb)
        )
        -- Oldest first so that when duplicates ALREADY exist on one number, the
        -- original wins the key below and callers are pointed at the canonical
        -- record rather than at whichever copy the planner happened to return.
        ORDER BY created_at ASC
    `)) as unknown as (ExistingLead & { match_digits: string })[];

    // Keyed by the caller's normalised phone, not by the stored text: callers do
    // existing.get(normalizePhone(raw)) and the stored value may be in any format.
    const out = new Map<string, ExistingLead>();
    for (const r of rows) {
        const key = byLast10.get(r.match_digits);
        if (key && !out.has(key)) {
            out.set(key, { id: r.id, phone: r.phone, lead_status: r.lead_status, city: r.city, state: r.state });
        }
    }
    return out;
}

/**
 * Single-lead convenience wrapper: normalise, look up, classify.
 *
 * For the Add-Lead form and the NeoDove inbound Lead-Create branch, where there
 * is no batch to amortise the query over. Bulk callers should use
 * loadExistingByPhone() + classifyAgainstExisting() directly.
 *
 * Returns `null` for `phone` when the input isn't a valid Indian mobile — the
 * caller decides whether that's a validation error or a silent skip.
 */
export async function classifyOne(
    rawPhone: string,
    city: string,
): Promise<DedupClassification & { phone: string | null }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
        return { phone: null, outcome: "valid", duplicateLeadId: null };
    }
    const existing = await loadExistingByPhone([phone]);
    return { phone, ...classifyAgainstExisting(city, existing.get(phone)) };
}
