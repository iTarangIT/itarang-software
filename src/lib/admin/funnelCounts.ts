/**
 * B10 — Admin funnel counts: dealers onboarded, KYC files shared, files
 * disbursed, files rejected (with reasons), sliced by city / state / month /
 * dealer / financier and filterable the same way.
 *
 * FOUR TABLES, ONE DEALER KEY. Everything resolves to `accounts.id` (the
 * dealer entity every `leads.dealer_id` and `users.dealer_id` points at):
 *
 *   dealers_onboarded   dealer_onboarding_applications.approved_at (NAIVE UTC
 *                       timestamp → istRangeNaive). City/state from the
 *                       application. Dealer = the account the application's
 *                       user was given, else the `dealers` row created for it.
 *   kyc_shared          DISTINCT lead_id in admin_verification_queue by
 *                       created_at — the same source the KYC Review digest
 *                       counts "new cases submitted" from. NOT admin_kyc_reviews
 *                       (the spec's suggestion): that table is empty on sandbox
 *                       and holds per-document review actions, not cases.
 *                       City/state/dealer via `leads`.
 *   files_disbursed     loan_sanctions.disbursed_at. NBFC = nbfc_id → nbfc_tenants.
 *   files_rejected      loan_sanctions.status = 'rejected' (case-insensitive),
 *                       dated by updated_at (there is no rejected_at). Reasons
 *                       grouped on lower(trim(rejection_reason)); blank → "Not
 *                       specified"; the first spelling seen is what is shown.
 *   onboarding_rejected EXTRA, outside the spec's four: applications with
 *                       rejected_at in range, with their own reasons list. Kept
 *                       separate so "rejected = Σ reasons" stays true for loans.
 *
 * THE NBFC FILTER TOUCHES ONLY THE LOAN COUNTS. Onboarding and KYC are not
 * NBFC-specific, so `nbfc_id` leaves them unfiltered and the result's `notes`
 * says so for the screen to print. Under group_by = nbfc those two counts land
 * on one row, "Not NBFC-specific", rather than being spread or dropped.
 *
 * TIMEZONE. All ranges are IST calendar days: tstz columns through istRangeTz,
 * the onboarding table's naive columns through istRangeNaive (see window.ts
 * for why the naive variant is not optional). "Month" groups on the IST month
 * of the event.
 */

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { istRangeNaive, istRangeTz } from "@/lib/digests/window";
import {
    FUNNEL_GROUP_BYS,
    type FunnelCounts,
    type FunnelCountsResult,
    type FunnelFilters,
    type FunnelGroupBy,
    type FunnelOption,
    type FunnelReason,
    type FunnelRow,
} from "./funnelCountsTypes";

export * from "./funnelCountsTypes";

// ─────────────────────────────── params ─────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const FunnelParamsSchema = z.object({
    from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD").optional(),
    to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD").optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    dealer_id: z.string().trim().min(1).max(64).optional(),
    nbfc_id: z.string().uuid("nbfc_id must be a tenant id").optional(),
    group_by: z.enum(FUNNEL_GROUP_BYS).default("none"),
});
export type FunnelParams = z.infer<typeof FunnelParamsSchema>;

export function parseFunnelParams(url: URL): FunnelParams {
    const p = url.searchParams;
    const get = (k: string) => {
        const v = p.get(k)?.trim();
        return v ? v : undefined;
    };
    return FunnelParamsSchema.parse({
        from: get("from"),
        to: get("to"),
        city: get("city"),
        state: get("state"),
        dealer_id: get("dealer_id"),
        nbfc_id: get("nbfc_id"),
        group_by: get("group_by"),
    });
}

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

async function istToday(): Promise<string> {
    const rows = await db.execute<{ today: string }>(sql`
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today
    `);
    return String((rows as unknown as { today: string }[])[0]!.today);
}

export function resolveFunnelFilters(p: FunnelParams, today: string): FunnelFilters {
    const to = p.to ?? today;
    const from = p.from ?? addDays(to, -29);
    if (from > to) throw new RangeError("`from` must not be after `to`.");
    return {
        from,
        to,
        city: p.city ?? null,
        state: p.state ?? null,
        dealer_id: p.dealer_id ?? null,
        nbfc_id: p.nbfc_id ?? null,
        group_by: p.group_by,
    };
}

// ─────────────────────────────── fragments ──────────────────────────────────

const num = (v: unknown) => Number(v ?? 0);

/** Case-folded, trimmed equality on a city/state column; unknown value = zero rows. */
function geo(col: SQL, value: string | null | undefined): SQL {
    return value ? sql` AND lower(trim(${col})) = lower(trim(${value}))` : sql``;
}

/** The group key + label expressions for one source. `nbfcKey` is null for sources that have no NBFC. */
function groupExprs(
    g: FunnelGroupBy,
    src: { city: SQL; state: SQL; at: SQL; dealerId: SQL; dealerName: SQL; nbfcId: SQL | null; nbfcName: SQL | null },
): { key: SQL; label: SQL } {
    switch (g) {
        case "city":
            return {
                key: sql`COALESCE(lower(trim(${src.city})), '')`,
                label: sql`COALESCE(NULLIF(trim(${src.city}), ''), '(not captured)')`,
            };
        case "state":
            return {
                key: sql`COALESCE(lower(trim(${src.state})), '')`,
                label: sql`COALESCE(NULLIF(trim(${src.state}), ''), '(not captured)')`,
            };
        case "month":
            return {
                key: sql`to_char(${src.at}, 'YYYY-MM')`,
                label: sql`to_char(${src.at}, 'Mon YYYY')`,
            };
        case "dealer":
            return {
                key: sql`COALESCE(${src.dealerId}, '')`,
                label: sql`COALESCE(${src.dealerName}, ${src.dealerId}, '(no dealer)')`,
            };
        case "nbfc":
            return src.nbfcId
                ? { key: sql`COALESCE(${src.nbfcId}::text, '')`, label: sql`COALESCE(${src.nbfcName}, '(no NBFC)')` }
                : { key: sql`'__none__'`, label: sql`'Not NBFC-specific'` };
        case "none":
        default:
            return { key: sql`''`, label: sql`''` };
    }
}

type Agg = { key: string; label: string; n: string };

async function agg(q: SQL): Promise<Map<string, { label: string; n: number }>> {
    const rows = (await db.execute<Agg>(q)) as unknown as Agg[];
    const out = new Map<string, { label: string; n: number }>();
    for (const r of rows) out.set(String(r.key), { label: String(r.label), n: num(r.n) });
    return out;
}

// ─────────────────────────────── sources ────────────────────────────────────

/** Approved applications. Dealer = the user's account, else the dealers row minted for the application. */
function onboardedQuery(f: FunnelFilters, g: FunnelGroupBy): SQL {
    const at = sql`(app.approved_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
    const dealerId = sql`COALESCE(u.dealer_id, d.dealer_id)`;
    const { key, label } = groupExprs(g, {
        city: sql`app.city`, state: sql`app.state`, at,
        dealerId, dealerName: sql`COALESCE(a.business_entity_name, app.company_name)`,
        nbfcId: null, nbfcName: null,
    });
    return sql`
        SELECT ${key} AS key, MIN(${label}) AS label, COUNT(*)::text AS n
          FROM dealer_onboarding_applications app
          LEFT JOIN users u ON u.id = app.dealer_user_id
          LEFT JOIN dealers d ON d.application_id = app.id::text
          LEFT JOIN accounts a ON a.id = COALESCE(u.dealer_id, d.dealer_id)
         WHERE app.approved_at IS NOT NULL
           AND ${istRangeNaive(sql`app.approved_at`, f.from, f.to)}
           ${geo(sql`app.city`, f.city)} ${geo(sql`app.state`, f.state)}
           ${f.dealer_id ? sql` AND COALESCE(u.dealer_id, d.dealer_id) = ${f.dealer_id}` : sql``}
         GROUP BY 1`;
}

function onboardingRejectedQuery(f: FunnelFilters, g: FunnelGroupBy): SQL {
    const at = sql`(app.rejected_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
    const dealerId = sql`COALESCE(u.dealer_id, d.dealer_id)`;
    const { key, label } = groupExprs(g, {
        city: sql`app.city`, state: sql`app.state`, at,
        dealerId, dealerName: sql`COALESCE(a.business_entity_name, app.company_name)`,
        nbfcId: null, nbfcName: null,
    });
    return sql`
        SELECT ${key} AS key, MIN(${label}) AS label, COUNT(*)::text AS n
          FROM dealer_onboarding_applications app
          LEFT JOIN users u ON u.id = app.dealer_user_id
          LEFT JOIN dealers d ON d.application_id = app.id::text
          LEFT JOIN accounts a ON a.id = COALESCE(u.dealer_id, d.dealer_id)
         WHERE app.rejected_at IS NOT NULL
           AND ${istRangeNaive(sql`app.rejected_at`, f.from, f.to)}
           ${geo(sql`app.city`, f.city)} ${geo(sql`app.state`, f.state)}
           ${f.dealer_id ? sql` AND COALESCE(u.dealer_id, d.dealer_id) = ${f.dealer_id}` : sql``}
         GROUP BY 1`;
}

/** Distinct leads whose case entered the KYC queue — one lead, one file, however many queue rows. */
function kycSharedQuery(f: FunnelFilters, g: FunnelGroupBy): SQL {
    const { key, label } = groupExprs(g, {
        city: sql`l.city`, state: sql`l.state`,
        at: sql`(q.first_at AT TIME ZONE 'Asia/Kolkata')`,
        dealerId: sql`l.dealer_id`, dealerName: sql`a.business_entity_name`,
        nbfcId: null, nbfcName: null,
    });
    return sql`
        WITH q AS (
            SELECT lead_id, MIN(created_at) AS first_at
              FROM admin_verification_queue
             GROUP BY lead_id
        )
        SELECT ${key} AS key, MIN(${label}) AS label, COUNT(*)::text AS n
          FROM q
          LEFT JOIN leads l ON l.id::text = q.lead_id
          LEFT JOIN accounts a ON a.id = l.dealer_id
         WHERE ${istRangeTz(sql`q.first_at`, f.from, f.to)}
           ${geo(sql`l.city`, f.city)} ${geo(sql`l.state`, f.state)}
           ${f.dealer_id ? sql` AND l.dealer_id = ${f.dealer_id}` : sql``}
         GROUP BY 1`;
}

function loanQuery(f: FunnelFilters, g: FunnelGroupBy, which: "disbursed" | "rejected"): SQL {
    const at = which === "disbursed"
        ? sql`(s.disbursed_at AT TIME ZONE 'Asia/Kolkata')`
        : sql`(COALESCE(s.updated_at, s.created_at) AT TIME ZONE 'Asia/Kolkata')`;
    const { key, label } = groupExprs(g, {
        city: sql`l.city`, state: sql`l.state`, at,
        dealerId: sql`l.dealer_id`, dealerName: sql`a.business_entity_name`,
        nbfcId: sql`s.nbfc_id`, nbfcName: sql`t.display_name`,
    });
    const where = which === "disbursed"
        ? sql`s.disbursed_at IS NOT NULL AND ${istRangeTz(sql`s.disbursed_at`, f.from, f.to)}`
        : sql`lower(s.status) = 'rejected' AND ${istRangeTz(sql`COALESCE(s.updated_at, s.created_at)`, f.from, f.to)}`;
    return sql`
        SELECT ${key} AS key, MIN(${label}) AS label, COUNT(*)::text AS n
          FROM loan_sanctions s
          LEFT JOIN leads l ON l.id::text = s.lead_id
          LEFT JOIN accounts a ON a.id = l.dealer_id
          LEFT JOIN nbfc_tenants t ON t.id = s.nbfc_id
         WHERE ${where}
           ${geo(sql`l.city`, f.city)} ${geo(sql`l.state`, f.state)}
           ${f.dealer_id ? sql` AND l.dealer_id = ${f.dealer_id}` : sql``}
           ${f.nbfc_id ? sql` AND s.nbfc_id = ${f.nbfc_id}::uuid` : sql``}
         GROUP BY 1`;
}

/** Reasons, folded case-insensitively; blank → "Not specified"; first spelling seen shown. */
async function loanRejectionReasons(f: FunnelFilters): Promise<FunnelReason[]> {
    const rows = (await db.execute<{ reason: string; n: string }>(sql`
        SELECT MIN(COALESCE(NULLIF(trim(s.rejection_reason), ''), 'Not specified')) AS reason,
               COUNT(*)::text AS n
          FROM loan_sanctions s
          LEFT JOIN leads l ON l.id::text = s.lead_id
         WHERE lower(s.status) = 'rejected'
           AND ${istRangeTz(sql`COALESCE(s.updated_at, s.created_at)`, f.from, f.to)}
           ${geo(sql`l.city`, f.city)} ${geo(sql`l.state`, f.state)}
           ${f.dealer_id ? sql` AND l.dealer_id = ${f.dealer_id}` : sql``}
           ${f.nbfc_id ? sql` AND s.nbfc_id = ${f.nbfc_id}::uuid` : sql``}
         GROUP BY lower(COALESCE(NULLIF(trim(s.rejection_reason), ''), 'Not specified'))
         ORDER BY COUNT(*) DESC, 1
    `)) as unknown as { reason: string; n: string }[];
    return rows.map((r) => ({ reason: String(r.reason), count: num(r.n) }));
}

async function onboardingRejectionReasons(f: FunnelFilters): Promise<FunnelReason[]> {
    const rows = (await db.execute<{ reason: string; n: string }>(sql`
        SELECT MIN(COALESCE(NULLIF(trim(app.rejection_reason), ''), 'Not specified')) AS reason,
               COUNT(*)::text AS n
          FROM dealer_onboarding_applications app
          LEFT JOIN users u ON u.id = app.dealer_user_id
          LEFT JOIN dealers d ON d.application_id = app.id::text
         WHERE app.rejected_at IS NOT NULL
           AND ${istRangeNaive(sql`app.rejected_at`, f.from, f.to)}
           ${geo(sql`app.city`, f.city)} ${geo(sql`app.state`, f.state)}
           ${f.dealer_id ? sql` AND COALESCE(u.dealer_id, d.dealer_id) = ${f.dealer_id}` : sql``}
         GROUP BY lower(COALESCE(NULLIF(trim(app.rejection_reason), ''), 'Not specified'))
         ORDER BY COUNT(*) DESC, 1
    `)) as unknown as { reason: string; n: string }[];
    return rows.map((r) => ({ reason: String(r.reason), count: num(r.n) }));
}

async function options(): Promise<{ dealers: FunnelOption[]; nbfcs: FunnelOption[] }> {
    const [dealers, nbfcs] = await Promise.all([
        db.execute<{ id: string; name: string }>(sql`
            SELECT a.id, COALESCE(a.business_entity_name, a.id) AS name
              FROM accounts a
             WHERE EXISTS (SELECT 1 FROM leads l WHERE l.dealer_id = a.id)
                OR EXISTS (SELECT 1 FROM users u WHERE u.dealer_id = a.id)
             ORDER BY 2
        `),
        db.execute<{ id: string; name: string }>(sql`
            SELECT t.id::text AS id, COALESCE(t.display_name, t.nbfc_legal_name, t.id::text) AS name
              FROM nbfc_tenants t
             ORDER BY 2
        `),
    ]);
    const map = (rows: unknown) =>
        (rows as { id: string; name: string }[]).map((r) => ({ id: String(r.id), name: String(r.name) }));
    return { dealers: map(dealers), nbfcs: map(nbfcs) };
}

// ─────────────────────────────── builder ────────────────────────────────────

const ZERO: FunnelCounts = {
    dealers_onboarded: 0,
    kyc_shared: 0,
    files_disbursed: 0,
    files_rejected: 0,
    onboarding_rejected: 0,
};

async function counts(f: FunnelFilters, g: FunnelGroupBy): Promise<Map<string, FunnelRow>> {
    const [onb, kyc, dis, rej, onbRej] = await Promise.all([
        agg(onboardedQuery(f, g)),
        agg(kycSharedQuery(f, g)),
        agg(loanQuery(f, g, "disbursed")),
        agg(loanQuery(f, g, "rejected")),
        agg(onboardingRejectedQuery(f, g)),
    ]);
    const rows = new Map<string, FunnelRow>();
    const put = (m: Map<string, { label: string; n: number }>, field: keyof FunnelCounts) => {
        for (const [key, v] of m) {
            const row = rows.get(key) ?? { key, label: v.label, ...ZERO };
            row[field] += v.n;
            if (!row.label && v.label) row.label = v.label;
            rows.set(key, row);
        }
    };
    put(onb, "dealers_onboarded");
    put(kyc, "kyc_shared");
    put(dis, "files_disbursed");
    put(rej, "files_rejected");
    put(onbRej, "onboarding_rejected");
    return rows;
}

export async function buildFunnelCounts(p: FunnelParams): Promise<FunnelCountsResult> {
    const today = await istToday();
    const f = resolveFunnelFilters(p, today);

    const [totalsMap, groupedMap, reasons, onbReasons, opts] = await Promise.all([
        counts(f, "none"),
        f.group_by === "none" ? Promise.resolve(new Map<string, FunnelRow>()) : counts(f, f.group_by),
        loanRejectionReasons(f),
        onboardingRejectionReasons(f),
        options(),
    ]);

    const totalsRow = totalsMap.get("") ?? { key: "", label: "", ...ZERO };
    const totals: FunnelCounts = {
        dealers_onboarded: totalsRow.dealers_onboarded,
        kyc_shared: totalsRow.kyc_shared,
        files_disbursed: totalsRow.files_disbursed,
        files_rejected: totalsRow.files_rejected,
        onboarding_rejected: totalsRow.onboarding_rejected,
    };

    const rows = [...groupedMap.values()].sort((a, b) => {
        // Months chronological; everything else by the biggest funnel first, then name.
        if (f.group_by === "month") return a.key.localeCompare(b.key);
        const sa = a.dealers_onboarded + a.kyc_shared + a.files_disbursed + a.files_rejected;
        const sb = b.dealers_onboarded + b.kyc_shared + b.files_disbursed + b.files_rejected;
        return sb - sa || a.label.localeCompare(b.label);
    });

    const notes: string[] = [];
    if (f.nbfc_id) {
        notes.push(
            "The financier filter applies to Files disbursed and Files rejected only. Dealers onboarded and KYC files shared are not NBFC-specific and are shown unfiltered.",
        );
    }
    if (f.group_by === "nbfc") {
        notes.push("Dealers onboarded and KYC files shared have no financier; they appear on the \"Not NBFC-specific\" row.");
    }
    notes.push(
        "KYC files shared counts each lead once, on the day its case first entered the KYC review queue. Files rejected are dated by the sanction's last update, as there is no rejection timestamp.",
    );

    return {
        filters: f,
        totals,
        rejection_reasons: reasons,
        onboarding_rejection_reasons: onbReasons,
        rows,
        notes,
        options: opts,
    };
}

// ─────────────────────────────── CSV ────────────────────────────────────────

export interface FunnelCsvSheet {
    columns: { header: string; value: (r: Record<string, unknown>) => string }[];
    rows: Record<string, unknown>[];
    filename: string;
}

const s = (v: unknown) => (v == null ? "" : String(v));

/** Grouped rows when grouped, else the totals as one row. Reasons go in a second block of the same sheet? No — one table only, so the CSV is what the screen's table shows. */
export function funnelCountsCsv(r: FunnelCountsResult): FunnelCsvSheet {
    const range = `${r.filters.from}_${r.filters.to}`;
    const base = [
        { header: "Dealers onboarded", value: (x: Record<string, unknown>) => s(x.dealers_onboarded) },
        { header: "KYC files shared", value: (x: Record<string, unknown>) => s(x.kyc_shared) },
        { header: "Files disbursed", value: (x: Record<string, unknown>) => s(x.files_disbursed) },
        { header: "Files rejected", value: (x: Record<string, unknown>) => s(x.files_rejected) },
        { header: "Onboarding rejected", value: (x: Record<string, unknown>) => s(x.onboarding_rejected) },
    ];
    if (r.filters.group_by === "none") {
        return {
            filename: `funnel-counts-${range}`,
            columns: [{ header: "Scope", value: () => "Total" }, ...base],
            rows: [{ ...r.totals }],
        };
    }
    return {
        filename: `funnel-counts-by-${r.filters.group_by}-${range}`,
        columns: [{ header: FUNNEL_GROUP_HEADER[r.filters.group_by], value: (x) => s(x.label) }, ...base],
        rows: r.rows.map((x) => ({ ...x })),
    };
}

const FUNNEL_GROUP_HEADER: Record<FunnelGroupBy, string> = {
    none: "Scope",
    city: "City",
    state: "State",
    month: "Month",
    dealer: "Dealer",
    nbfc: "Financier",
};
