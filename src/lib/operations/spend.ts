/**
 * The read model behind /operations/spend, plus the query helpers its collector
 * shares.
 *
 * WHY THIS READS TABLES DIRECTLY RATHER THAN ops_metric_samples.
 * Every other module page renders samples, because its numbers come from
 * somewhere the page cannot reach (a box, a vendor API, pg_stat_*). Spend is
 * different: the money already lives in this database. Reading it directly buys
 * a real monthly SERIES for the burn chart and a matched-window reconciliation,
 * neither of which a single stored scalar per metric can express.
 *
 * The one number that genuinely cannot be derived here is the vendor credit
 * balance — only ElevenLabs knows that — so that alone comes from samples.
 *
 * WINDOWS. The reconciliation table uses trailing 30 days on BOTH halves. That
 * is the whole point: metered-over-30d against billed-MTD would be comparing
 * different spans and every row would look wrong on the 2nd of the month. The
 * MTD figure survives only as the headline, matching spend.billed_tech_mtd in
 * registry.ts.
 *
 * MONEY IS INR PAISE. expense_submissions.amount is already the INR-converted
 * figure (original_amount x fx_rate, computed at entry); ai_call_logs
 * .total_cost_cents is already INR paise for every provider. Neither gets an FX
 * rate applied again — doing so once turned a $200 Anthropic bill into ₹1.7 lakh.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { toNumber } from "./format";
import { latestSamples, bySourceKey } from "./samples";
import { canonicalVendor, vendorDef, vendorLabel } from "./vendors";

const rows = async (
  query: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>>> =>
  (await db.execute(query)) as unknown as Array<Record<string, unknown>>;

const paise = (value: unknown): number => {
  const n = toNumber(value);
  return n == null ? 0 : Math.round(n * 100);
};

/**
 * Which column marks an expense as tech spend on THIS database.
 *
 * `bucket` (E-217) exists on the deployed databases but is not declared in
 * src/lib/db/schema.ts on this branch, so neither can be assumed. Ask the
 * catalog instead of hard-coding: a `WHERE bucket = 'tech'` against an
 * environment built from schema.ts alone would fail every spend query.
 *
 * Exported because the collector needs the same answer, and two copies of this
 * decision would eventually disagree.
 */
export async function techFilterColumn(): Promise<
  "bucket" | "department" | null
> {
  const present = await rows(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'expense_submissions'
      AND column_name IN ('bucket', 'department')
  `);
  const have = new Set(present.map((r) => String(r.column_name)));
  if (have.has("bucket")) return "bucket";
  if (have.has("department")) return "department";
  return null;
}

/**
 * The effective date of an invoice: the date on the bill, falling back to when
 * it was approved. Filing by created_at would bucket a February invoice
 * uploaded in April under April.
 */
const EFFECTIVE_DATE = sql`
  COALESCE(expense_date, (approved_at AT TIME ZONE 'Asia/Kolkata')::date)
`;

export interface MonthBurn {
  /** YYYY-MM in IST. */
  month: string;
  paise: number;
  invoices: number;
}

export interface VendorRow {
  id: string;
  label: string;
  /** False when the invoice entity matched no known vendor. */
  matched: boolean;
  /** Trailing-30d invoiced total, INR paise. */
  billed_paise: number;
  billed_invoices: number;
  /** Trailing-30d metered cost where we have one (AI providers only). */
  metered_paise: number | null;
  /** Trailing-30d billable API volume where we can count it. */
  metered_calls: number | null;
  /** What the metered half was derived from, for the row's tooltip. */
  metered_from: string | null;
  /** Invoice entity names that rolled up into this row. */
  entities: string[];
}

export interface CreditTile {
  vendor: string;
  label: string;
  remaining: number | null;
  used_pct: number | null;
  tier: string | null;
  reset_at: string | null;
  age_minutes: number | null;
}

export interface SpendView {
  /** Newest first. Index 0 is the current (partial) month. */
  burn: MonthBurn[];
  mom_delta_pct: number | null;
  billed_tech_mtd_paise: number;
  billed_tech_30d_paise: number;
  ai_cost_30d_paise: number;
  ai_calls_30d: number;
  vendors: VendorRow[];
  credits: CreditTile[];
  /** Current month in IST, YYYY-MM. The page uses it to mark the partial bar. */
  current_month: string;
  /** Null when neither `bucket` nor `department` exists on this database. */
  tech_filter_column: "bucket" | "department" | null;
}

export async function getSpendView(): Promise<SpendView> {
  const column = await techFilterColumn();

  // ---- metered: AI calls -------------------------------------------------
  // Not joined to dialer_campaign_leads. That join is what made Cost Analytics
  // read ~5x low before May 2026 — calls outside a campaign, and campaign calls
  // whose webhook dropped, have no DCL row. Spend is spend.
  const [aiTotal] = await rows(sql`
    SELECT
      COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
      COUNT(*)::int                              AS calls
    FROM ai_call_logs
    WHERE call_id IS NOT NULL AND ended_at > NOW() - INTERVAL '30 days'
  `);

  const aiByProvider = await rows(sql`
    SELECT provider,
           COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
           COUNT(*)::int                              AS calls
    FROM ai_call_logs
    WHERE call_id IS NOT NULL AND ended_at > NOW() - INTERVAL '30 days'
      AND provider IS NOT NULL
    GROUP BY provider
  `);

  // ---- billed ------------------------------------------------------------
  let burn: MonthBurn[] = [];
  let billedMtd = 0;
  let billed30d = 0;
  const billedByVendor = new Map<
    string,
    { label: string; matched: boolean; paise: number; invoices: number; entities: string[] }
  >();

  if (column) {
    const scope = sql`
      WHERE ${sql.raw(column)} = 'tech' AND status = 'approved'
    `;

    const monthly = await rows(sql`
      SELECT TO_CHAR(${EFFECTIVE_DATE}, 'YYYY-MM') AS month,
             COALESCE(SUM(amount), 0)::numeric     AS inr,
             COUNT(*)::int                         AS invoices
      FROM expense_submissions ${scope}
        AND ${EFFECTIVE_DATE} IS NOT NULL
      GROUP BY month
      ORDER BY month DESC
      LIMIT 6
    `);
    burn = monthly.map((r) => ({
      month: String(r.month),
      paise: paise(r.inr),
      invoices: Number(r.invoices ?? 0),
    }));

    const [mtd] = await rows(sql`
      SELECT COALESCE(SUM(amount), 0)::numeric AS inr
      FROM expense_submissions ${scope}
        AND ${EFFECTIVE_DATE} >= DATE_TRUNC('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))::date
    `);
    billedMtd = paise(mtd?.inr);

    const perVendor = await rows(sql`
      SELECT vendor,
             COALESCE(SUM(amount), 0)::numeric AS inr,
             COUNT(*)::int                     AS invoices
      FROM expense_submissions ${scope}
        AND vendor IS NOT NULL
        AND ${EFFECTIVE_DATE} > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30
      GROUP BY vendor
    `);

    for (const r of perVendor) {
      const raw = String(r.vendor);
      const vendor = canonicalVendor(raw);
      if (!vendor) continue;
      const entry = billedByVendor.get(vendor.id) ?? {
        label: vendor.label,
        matched: vendor.matched,
        paise: 0,
        invoices: 0,
        entities: [],
      };
      entry.paise += paise(r.inr);
      entry.invoices += Number(r.invoices ?? 0);
      if (!entry.entities.includes(raw)) entry.entities.push(raw);
      billedByVendor.set(vendor.id, entry);
      billed30d += paise(r.inr);
    }
  }

  // ---- metered volume + credits, from samples -----------------------------
  const samples = await latestSamples(
    ["vendor.api_calls_30d", "vendor.credits_remaining", "vendor.credits_used_pct"],
    { maxAgeHours: 48 },
  );
  const index = bySourceKey(samples);

  const meteredCalls = new Map<string, number>();
  for (const s of samples) {
    if (s.metric_key !== "vendor.api_calls_30d") continue;
    if (s.value_num == null) continue;
    meteredCalls.set(s.source.replace(/^vendor:/, ""), s.value_num);
  }

  const meteredCost = new Map<string, { paise: number; calls: number }>();
  for (const r of aiByProvider) {
    const vendor = canonicalVendor(String(r.provider));
    if (!vendor) continue;
    meteredCost.set(vendor.id, {
      paise: Number(r.cost_cents ?? 0),
      calls: Number(r.calls ?? 0),
    });
  }

  // Union of both halves: a vendor we metered but were not billed for (usage on
  // a prepaid plan) and a vendor we were billed for but do not meter (a SaaS
  // seat) are both interesting, and both would vanish from an inner join.
  const vendorIds = new Set([
    ...billedByVendor.keys(),
    ...meteredCost.keys(),
    ...meteredCalls.keys(),
  ]);

  const vendors: VendorRow[] = [...vendorIds]
    .map((id): VendorRow => {
      const billed = billedByVendor.get(id);
      const cost = meteredCost.get(id);
      const calls = meteredCalls.get(id);
      return {
        id,
        label: billed?.label ?? vendorLabel(id),
        matched: billed?.matched ?? true,
        billed_paise: billed?.paise ?? 0,
        billed_invoices: billed?.invoices ?? 0,
        metered_paise: cost?.paise ?? null,
        metered_calls: cost?.calls ?? calls ?? null,
        metered_from: vendorDef(id)?.meteredFrom ?? null,
        entities: billed?.entities ?? [],
      };
    })
    .sort(
      (a, b) =>
        Math.max(b.billed_paise, b.metered_paise ?? 0) -
        Math.max(a.billed_paise, a.metered_paise ?? 0),
    );

  const credits: CreditTile[] = [...new Set(
    samples
      .filter((s) => s.metric_key.startsWith("vendor.credits"))
      .map((s) => s.source),
  )].map((source) => {
    const remaining = index.get(`vendor.credits_remaining|${source}`);
    const usedPct = index.get(`vendor.credits_used_pct|${source}`);
    const meta = (remaining?.meta ?? usedPct?.meta ?? {}) as Record<string, unknown>;
    const id = source.replace(/^vendor:/, "");
    return {
      vendor: id,
      label: vendorLabel(id),
      remaining: remaining?.value_num ?? null,
      used_pct: usedPct?.value_num ?? null,
      tier: typeof meta.tier === "string" ? meta.tier : null,
      reset_at: typeof meta.reset_at === "string" ? meta.reset_at : null,
      age_minutes: remaining?.age_minutes ?? usedPct?.age_minutes ?? null,
    };
  });

  // MoM compares the two most recent COMPLETE months. Comparing a part-month
  // against a whole one always shows a fake collapse, and on the 1st it would
  // read as -100%.
  //
  // "Complete" is decided by comparing against the actual current IST month,
  // NOT by dropping burn[0]. A month with no invoices yet produces no row at
  // all, so on 4 August the newest row is July — a finished month — and
  // dropping it silently compared June against May while ignoring the most
  // recent real data.
  const currentMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);

  const complete = burn.filter((m) => m.month !== currentMonth);
  const momDelta =
    complete.length >= 2 && complete[1]!.paise > 0
      ? ((complete[0]!.paise - complete[1]!.paise) / complete[1]!.paise) * 100
      : null;

  return {
    burn,
    mom_delta_pct: momDelta,
    billed_tech_mtd_paise: billedMtd,
    billed_tech_30d_paise: billed30d,
    ai_cost_30d_paise: Number(aiTotal?.cost_cents ?? 0),
    ai_calls_30d: Number(aiTotal?.calls ?? 0),
    vendors,
    credits,
    current_month: currentMonth,
    tech_filter_column: column,
  };
}
