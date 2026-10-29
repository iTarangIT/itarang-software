/**
 * Tracker ID 197 (PJP phase 1) — travel expense proof, the database side.
 * Server only. Rules: ./travelProof.ts. Tables: drizzle/E-364 (claim days),
 * the evidence is read live from lead_visits (E-363, ID 196).
 *
 * E-364 / E-363 columns are NOT in schema.ts: raw SQL, new lead_visits columns
 * read through to_jsonb, the claim-days table behind hasClaimDays().
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { humanCall } from "@/lib/reports/metricDefinitions";
import { geocodeShop, haversineMeters } from "@/lib/assistant/geo";
import { verdictFor, type DayVerdict } from "./travelProof";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let probe: { at: number; ok: boolean } | null = null;

/** Is E-364 on this database? Cached for a minute. */
export async function hasClaimDays(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 60_000) return probe.ok;
    let ok = false;
    try {
        const r = rowsOf<{ ok: boolean }>(
            await db.execute(sql`SELECT to_regclass('public.expense_claim_days') IS NOT NULL AS ok`),
        );
        ok = Boolean(r[0]?.ok);
    } catch {
        ok = false;
    }
    probe = { at: Date.now(), ok };
    return ok;
}

export type VisitKind = "existing_counter" | "existing_lead" | "new_lead";

export const VISIT_KIND_LABEL: Record<VisitKind, string> = {
    existing_counter: "Existing counter",
    existing_lead: "Existing lead",
    new_lead: "New lead",
};

export type EvidenceVisit = {
    visit_id: string;
    at: string;
    verified: boolean;
    kind: VisitKind;
    name: string | null;
    city: string | null;
    planned: boolean;
    outcome: string | null;
    photo_url: string | null;
    accuracy_m: number | null;
    /** Metres from the shop's mapped address, when both are known. */
    distance_m: number | null;
    territory: "in" | "outside" | "territory_not_set" | "no_location";
};

export type DayEvidence = {
    day: string;
    verdict: DayVerdict;
    visits: EvidenceVisit[];
    first_visit_at: string | null;
    last_visit_at: string | null;
    cities: string[];
    calls: number;
};

type VisitRow = Omit<EvidenceVisit, "distance_m"> & {
    lat: number | null;
    lng: number | null;
    area: string | null;
    state: string | null;
    pincode: string | null;
};

/**
 * One person's day: every visit they logged as done (verified or not), the
 * calls they made, and the verdict. `withDistance` geocodes each shop address
 * (cached per process) — only for the CEO's Day evidence, not the live check
 * on the submit form.
 */
export async function dayEvidence(userId: string, day: string, opts: { withDistance?: boolean } = {}): Promise<DayEvidence> {
    const visits = rowsOf<VisitRow>(
        await db.execute(sql`
            SELECT v.visit_id::text AS visit_id,
                   COALESCE(to_jsonb(v) ->> 'captured_at', v.created_at::text) AS at,
                   COALESCE((to_jsonb(v) ->> 'verified') = 'true', false) AS verified,
                   CASE WHEN (to_jsonb(v) ->> 'account_id') IS NOT NULL
                          OR EXISTS (SELECT 1 FROM account_ownership ao WHERE ao.source_dealer_lead_id = v.dealer_lead_id)
                        THEN 'existing_counter'
                        WHEN ((dl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date = v.actual_visit_date THEN 'new_lead'
                        ELSE 'existing_lead' END AS kind,
                   COALESCE(NULLIF(dl.shop_name, ''), dl.dealer_name, a.business_entity_name) AS name,
                   COALESCE(dl.city, a.city) AS city,
                   COALESCE(dl.state, a.state) AS state,
                   dl.area, COALESCE(dl.pincode, a.pincode) AS pincode,
                   v.scheduled_date IS NOT NULL AS planned,
                   v.visit_outcome AS outcome,
                   CASE WHEN jsonb_typeof(v.photos) = 'array' THEN v.photos ->> 0 END AS photo_url,
                   (to_jsonb(v) ->> 'gps_accuracy_m')::float8 AS accuracy_m,
                   v.gps_check_in_lat::float8 AS lat, v.gps_check_in_lng::float8 AS lng,
                   CASE WHEN COALESCE(dl.state, a.state) IS NULL THEN 'no_location'
                        WHEN NOT EXISTS (SELECT 1 FROM asm_territories t WHERE t.asm_id = v.asm_id) THEN 'territory_not_set'
                        WHEN EXISTS (
                            SELECT 1 FROM asm_territories t
                             WHERE t.asm_id = v.asm_id
                               AND t.state = COALESCE(dl.state, a.state)
                               AND (t.city IS NULL OR t.city = COALESCE(dl.city, a.city))
                               AND (t.active_from IS NULL OR t.active_from <= v.actual_visit_date)
                               AND (t.active_to IS NULL OR t.active_to >= v.actual_visit_date))
                        THEN 'in' ELSE 'outside' END AS territory
              FROM lead_visits v
              LEFT JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
              LEFT JOIN accounts a ON a.id = COALESCE(
                  to_jsonb(v) ->> 'account_id',
                  (SELECT ao.account_id FROM account_ownership ao WHERE ao.source_dealer_lead_id = v.dealer_lead_id LIMIT 1))
             WHERE v.asm_id = ${userId}
               AND v.visit_status = 'visited'
               AND v.actual_visit_date = ${day}::date
             ORDER BY 2
        `),
    );
    const [calls] = rowsOf<{ n: number }>(
        await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM lead_touchpoints t
             WHERE t.performed_by = ${userId}
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
               AND ${humanCall(sql`t`)}
        `),
    );

    const out: EvidenceVisit[] = [];
    for (const v of visits) {
        let distance: number | null = null;
        if (opts.withDistance && v.lat != null && v.lng != null) {
            const shop = await geocodeShop({ area: v.area, city: v.city, state: v.state, pincode: v.pincode });
            // A city-level geocode is too coarse to call a distance "from the shop".
            if (shop && shop.precision !== "city") distance = Math.round(haversineMeters(v.lat, v.lng, shop.lat, shop.lng));
        }
        const { lat: _lat, lng: _lng, area: _area, state: _state, pincode: _pin, ...rest } = v;
        void _lat; void _lng; void _area; void _state; void _pin;
        out.push({ ...rest, verified: Boolean(v.verified), planned: Boolean(v.planned), distance_m: distance });
    }
    return {
        day,
        verdict: verdictFor(out),
        visits: out,
        first_visit_at: out[0]?.at ?? null,
        last_visit_at: out[out.length - 1]?.at ?? null,
        cities: [...new Set(out.map((v) => v.city).filter((c): c is string => !!c))],
        calls: Number(calls?.n ?? 0),
    };
}

/** Of `days`, those already in another pending or approved claim of this person and category. */
export async function daysAlreadyClaimed(userId: string, category: string, days: readonly string[], tx?: Tx): Promise<string[]> {
    if (days.length === 0) return [];
    const rows = rowsOf<{ day: string }>(
        await (tx ?? db).execute(sql`
            SELECT DISTINCT d.day::text AS day
              FROM expense_claim_days d
              JOIN expense_submissions e ON e.id = d.expense_id
             WHERE d.user_id = ${userId}
               AND d.category = ${category}
               AND e.status IN ('pending', 'approved')
               AND d.day IN (${sql.join(days.map((d) => sql`${d}::date`), sql`, `)})
        `),
    );
    return rows.map((r) => r.day).sort();
}

export async function insertClaimDays(
    tx: Tx,
    input: { expenseId: string; userId: string; category: string; days: ReadonlyArray<{ day: string; verdict: DayVerdict; note: string | null }> },
): Promise<void> {
    for (const d of input.days) {
        await tx.execute(sql`
            INSERT INTO expense_claim_days (expense_id, user_id, category, day, verdict, note)
            VALUES (${input.expenseId}::uuid, ${input.userId}, ${input.category}, ${d.day}::date, ${d.verdict}, ${d.note})
        `);
    }
}

export type ClaimDay = { day: string; verdict: DayVerdict; note: string | null };

/** expense id → its claimed days (day order). Empty map without E-364. */
export async function claimDaysFor(expenseIds: readonly string[]): Promise<Map<string, ClaimDay[]>> {
    const out = new Map<string, ClaimDay[]>();
    if (expenseIds.length === 0 || !(await hasClaimDays())) return out;
    const rows = rowsOf<ClaimDay & { expense_id: string }>(
        await db.execute(sql`
            SELECT expense_id::text AS expense_id, day::text AS day, verdict, note
              FROM expense_claim_days
             WHERE expense_id IN (${sql.join(expenseIds.map((id) => sql`${id}::uuid`), sql`, `)})
             ORDER BY day
        `),
    );
    for (const r of rows) {
        const list = out.get(r.expense_id) ?? [];
        list.push({ day: r.day, verdict: r.verdict, note: r.note });
        out.set(r.expense_id, list);
    }
    return out;
}
