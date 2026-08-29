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
 * WINDOWS. The reconciliation table uses ONE window across BOTH halves, and the
 * window is chosen by the reader (see ./spendWindow.ts). That matched span is
 * the whole point: metered-over-30d against billed-MTD would be comparing
 * different periods and every row would look wrong on the 2nd of the month.
 *
 * The default is the CURRENT MONTH rather than trailing 30 days. Both are
 * defensible, but only one of them agrees with the burn chart directly above
 * it — and an unlabelled 30-day figure sitting under a month-to-date figure is
 * what made a correct Hostinger total (₹28,387.88, which legitimately includes
 * two July invoices) read as a bug. Trailing 30 days is still selectable.
 *
 * The MTD figure survives as the headline regardless of the selected window,
 * matching spend.billed_tech_mtd in registry.ts.
 *
 * MONEY IS INR PAISE. expense_submissions.amount is already the INR-converted
 * figure (original_amount x fx_rate, computed at entry); ai_call_logs
 * .total_cost_cents is already INR paise for every provider. Neither gets an FX
 * rate applied again — doing so once turned a $200 Anthropic bill into ₹1.7 lakh.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { addMonths, istDay, istMonth, momDelta } from "./elevenlabsSeries";
import { toNumber } from "./format";
import { latestSamples, bySourceKey } from "./samples";
import {
  defaultSpendWindow,
  resolveSpendWindow,
  type SpendWindow,
  type SpendWindowKey,
} from "./spendWindow";
import {
  classifyTechSpend,
  REASON_LABELS,
  type TechSpendReason,
} from "./techSpendRules";
import {
  canonicalVendor,
  vendorDef,
  vendorLabel,
  vendorMeteredUnit,
  vendorMeteringNotApplicable,
} from "./vendors";

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
  /** Invoiced total over the selected window, INR paise. */
  billed_paise: number;
  billed_invoices: number;
  /** Metered cost over the same window, where we have one (AI providers only). */
  metered_paise: number | null;
  /** Metered volume over the same window, where we can count it. */
  metered_calls: number | null;
  /** What one unit of `metered_calls` is — never render the count without it. */
  metered_unit: string | null;
  /** What the metered half was derived from, for the row's tooltip. */
  metered_from: string | null;
  /**
   * True when metering this vendor is not a concept (a VPS, a SaaS seat).
   * The row still belongs in the table — the invoice is real — but its metered
   * half reads "not applicable" rather than an em-dash that means "missing".
   */
  metering_not_applicable: boolean;
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

/** One invoice behind a month's burn total. */
export interface BreakdownRow {
  id: string;
  vendor: string | null;
  vendor_label: string | null;
  invoice_number: string | null;
  description: string | null;
  effective_date: string | null;
  paise: number;
  /**
   * False for rows the Tech Spend rules removed. They are still LISTED — the
   * drill-down's job is to explain the bar, and "this invoice exists but is not
   * in the total, because …" is part of that explanation — but they do not
   * count toward it.
   */
  included: boolean;
  reason_label: string;
  explanation: string;
}

/**
 * One invoice the classifier removed from Tech Spend, with the reason.
 *
 * Rendered in full on the page. The rules can only narrow `bucket = 'tech'`, so
 * every row here is money that WAS in the headline and no longer is — and the
 * card footer reconciles kept + excluded back to the unfiltered total. An
 * over-eager rule therefore shows up as a visible line item rather than as a
 * number that quietly got smaller.
 */
export interface ExcludedRow {
  vendor: string | null;
  vendor_label: string | null;
  description: string | null;
  effective_date: string | null;
  paise: number;
  reason: TechSpendReason;
  reason_label: string;
  explanation: string;
}

export interface SpendView {
  /** Newest first. Index 0 is the current (partial) month. Gap-filled. */
  burn: MonthBurn[];
  mom_delta_pct: number | null;
  billed_tech_mtd_paise: number;
  /** Billed in the SELECTED window — same population as MTD. */
  billed_window_paise: number;
  /** Rows the classifier removed from the window, newest-largest first. */
  excluded: ExcludedRow[];
  /** What those rows total. `billed_window_paise + this` = the unfiltered total. */
  excluded_window_paise: number;
  /** Approved tech invoices with no usable date — in NO figure on this page. */
  undated_invoices: number;
  undated_paise: number;
  /** Included window money on invoices with a blank vendor. */
  no_vendor_paise: number;
  no_vendor_invoices: number;
  ai_cost_window_paise: number;
  ai_calls_window: number;
  vendors: VendorRow[];
  credits: CreditTile[];
  /** Current month in IST, YYYY-MM. The page uses it to mark the partial bar. */
  current_month: string;
  /** The window both halves of the reconciliation were computed over. */
  window: SpendWindow;
  /** Null when neither `bucket` nor `department` exists on this database. */
  tech_filter_column: "bucket" | "department" | null;
}

export async function getSpendView(
  windowKey?: SpendWindowKey,
): Promise<SpendView> {
  const column = await techFilterColumn();
  const window = resolveSpendWindow(windowKey ?? defaultSpendWindow());

  // Inclusive IST day bounds, applied identically to both halves. `to` is
  // expressed as `< to + 1 day` so the last day is whole — the same boundary
  // convention whereClauseAcl uses, so the two surfaces cannot drift.
  const meteredWindow = sql`
    AND ended_at >= (${window.from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND ended_at <  ((${window.to}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
  `;

  // ---- metered: AI calls -------------------------------------------------
  // Not joined to dialer_campaign_leads. That join is what made Cost Analytics
  // read ~5x low before May 2026 — calls outside a campaign, and campaign calls
  // whose webhook dropped, have no DCL row. Spend is spend.
  //
  // Bounded by the selected window rather than a hardcoded `NOW() - INTERVAL
  // '30 days'`, so the metered half moves with the billed half.
  const [aiTotal] = await rows(sql`
    SELECT
      COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
      COUNT(*)::int                              AS calls
    FROM ai_call_logs
    WHERE call_id IS NOT NULL ${meteredWindow}
  `);

  const aiByProvider = await rows(sql`
    SELECT provider,
           COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
           COUNT(*)::int                              AS calls
    FROM ai_call_logs
    WHERE call_id IS NOT NULL ${meteredWindow}
      AND provider IS NOT NULL
    GROUP BY provider
  `);

  // ---- billed ------------------------------------------------------------
  // The current IST month, needed here (not just at the end) because the burn
  // range is anchored to it.
  const currentMonth = istMonth();

  let burn: MonthBurn[] = [];
  let billedMtd = 0;
  let billedWindowPaise = 0;
  /** Money the classifier removed from the window, itemised on the page. */
  const excluded: ExcludedRow[] = [];
  let excludedWindowPaise = 0;
  /** Approved tech invoices with no usable date — outside every figure here. */
  let undatedInvoices = 0;
  let undatedPaise = 0;
  /** Included invoices carrying no vendor. Real money, no row to sit on. */
  let noVendorPaise = 0;
  let noVendorInvoices = 0;
  const billedByVendor = new Map<
    string,
    { label: string; matched: boolean; paise: number; invoices: number; entities: string[] }
  >();

  if (column) {
    const scope = sql`
      WHERE ${sql.raw(column)} = 'tech' AND status = 'approved'
    `;

    // Six calendar months back from the current one, so the range is fixed
    // rather than "the six months that happen to have invoices". LIMIT 6 on a
    // DESC scan returned the six most recent months WITH ROWS and the chart
    // drew them evenly spaced — a month with no tech spend simply vanished and
    // the gap rendered as continuity.
    const oldestMonth = addMonths(currentMonth, -5);
    const today = istDay();

    // ONE ROW-LEVEL QUERY, not four aggregates.
    //
    // Tech Spend is no longer `SUM(amount) WHERE bucket = 'tech'`: that column
    // is written by a process outside this repository and files our own GST
    // payments, retail electronics and recruitment invoices as technology. The
    // correction is per-row (see techSpendRules.ts), and a SUM() cannot be
    // filtered per row after the fact — so the rows are fetched once and every
    // figure on the page is folded out of the SAME classified list. Burn, MTD,
    // the window total, the vendor table and the exclusions panel are then
    // arithmetically incapable of disagreeing with each other.
    //
    // The volume this walks is ~80 rows for all time on the current data. The
    // aggregates it replaces were four round trips against the instance this
    // console exists to keep connections free on.
    //
    // UPPER-BOUNDED, unlike the MTD aggregate it replaces. That query was
    // `>= DATE_TRUNC('month', now())` with no ceiling, so an invoice carrying a
    // mistyped future expense_date counted toward "MTD" forever while the
    // window total beside it — which IS bounded — excluded it. Two numbers in
    // one card footer that could not be reconciled.
    const rangeFrom =
      window.from < `${oldestMonth}-01` ? window.from : `${oldestMonth}-01`;
    const rangeTo = window.to > today ? window.to : today;

    const invoices = await rows(sql`
      SELECT vendor,
             description,
             TO_CHAR(${EFFECTIVE_DATE}, 'YYYY-MM')  AS month,
             ${EFFECTIVE_DATE}::text                AS effective_date,
             COALESCE(amount, 0)::numeric           AS inr
      FROM expense_submissions ${scope}
        AND ${EFFECTIVE_DATE} >= ${rangeFrom}::date
        AND ${EFFECTIVE_DATE} <= ${rangeTo}::date
    `);

    // Approved tech invoices with NEITHER an expense_date NOR an approved_at.
    // EFFECTIVE_DATE is NULL for them, so they fail every bound above and sit
    // outside all six bars, MTD, the window total and the breakdown at once —
    // consistently invisible, which is exactly why nobody would notice. Counted
    // so the page can say they exist rather than quietly losing the money.
    const [undated] = await rows(sql`
      SELECT COUNT(*)::int                     AS invoices,
             COALESCE(SUM(amount), 0)::numeric AS inr
      FROM expense_submissions ${scope}
        AND ${EFFECTIVE_DATE} IS NULL
    `);
    undatedInvoices = Number(undated?.invoices ?? 0);
    undatedPaise = paise(undated?.inr);

    const byMonth = new Map<string, { paise: number; invoices: number }>();
    const monthStart = `${currentMonth}-01`;

    for (const r of invoices) {
      const vendorRaw = r.vendor == null ? null : String(r.vendor);
      const description = r.description == null ? null : String(r.description);
      const amount = paise(r.inr);
      const month = r.month == null ? null : String(r.month);
      const day =
        r.effective_date == null ? null : String(r.effective_date).slice(0, 10);
      if (!day) continue;

      const verdict = classifyTechSpend({ vendor: vendorRaw, description });
      const inWindow = day >= window.from && day <= window.to;

      if (!verdict.include) {
        // Excluded from every total, and itemised for the window on screen.
        // An exclusion nobody can see is indistinguishable from a bug.
        if (inWindow) {
          excluded.push({
            vendor: vendorRaw,
            vendor_label: vendorRaw
              ? (canonicalVendor(vendorRaw)?.label ?? vendorRaw)
              : null,
            description,
            effective_date: day,
            paise: amount,
            reason: verdict.reason,
            reason_label: REASON_LABELS[verdict.reason],
            explanation: verdict.explanation,
          });
          excludedWindowPaise += amount;
        }
        continue;
      }

      if (month) {
        const hit = byMonth.get(month) ?? { paise: 0, invoices: 0 };
        hit.paise += amount;
        hit.invoices += 1;
        byMonth.set(month, hit);
      }

      // Month-to-date: this calendar month, up to and including today. The
      // upper bound is the fix described above.
      if (day >= monthStart && day <= today) billedMtd += amount;

      if (!inWindow) continue;
      billedWindowPaise += amount;

      // Blank-vendor invoices are real money and used to be dropped from the
      // vendor table by `AND vendor IS NOT NULL`, so the rows could not sum to
      // the headline and nothing on screen said why. They roll up into an
      // explicit residual row instead.
      if (!vendorRaw || !vendorRaw.trim()) {
        noVendorPaise += amount;
        noVendorInvoices += 1;
        continue;
      }

      const vendor = canonicalVendor(vendorRaw);
      if (!vendor) continue;
      const entry = billedByVendor.get(vendor.id) ?? {
        label: vendor.label,
        matched: vendor.matched,
        paise: 0,
        invoices: 0,
        entities: [],
      };
      entry.paise += amount;
      entry.invoices += 1;
      if (!entry.entities.includes(vendorRaw)) entry.entities.push(vendorRaw);
      billedByVendor.set(vendor.id, entry);
    }

    burn = [];
    for (let i = 0; i < 6; i++) {
      const month = addMonths(currentMonth, -i);
      const hit = byMonth.get(month);
      burn.push({
        month,
        paise: hit?.paise ?? 0,
        invoices: hit?.invoices ?? 0,
      });
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
    const id = s.source.replace(/^vendor:/, "");
    // A sample is rendered only while the vendor still DECLARES where its
    // metered volume comes from. Three probes were withdrawn as misattributions
    // (zoho counted our own invoice syncs, openai counted Anthropic's LLM runs,
    // firecrawl counted whole scraper runs) — but withdrawing the probe only
    // stops new samples, and latestSamples() keeps serving the old ones for up
    // to 48 hours. Without this guard the retired rows would linger on the
    // page, now stripped of their unit label, which is strictly worse than
    // before. Gating on the declaration makes the removal take effect at once
    // and keeps vendors.ts the single source of truth for what is metered.
    if (!vendorDef(id)?.meteredFrom) continue;
    meteredCalls.set(id, s.value_num);
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
        metered_unit: vendorMeteredUnit(id),
        metered_from: vendorDef(id)?.meteredFrom ?? null,
        metering_not_applicable: vendorMeteringNotApplicable(id),
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
  //
  // Shared with the ElevenLabs page rather than reimplemented: momDelta() also
  // enforces that the two months are ADJACENT, which this open-coded version
  // did not. `burn` is now gap-filled, so a missing month is a zero row rather
  // than an absent one and the adjacency check passes on real data — but the
  // guarantee belongs in one place.
  const complete = burn.filter((m) => m.month !== currentMonth);
  const momDeltaPct = momDelta(
    complete.map((m) => ({ month: m.month, calls: m.invoices, cost_paise: m.paise })),
    currentMonth,
  );

  return {
    burn,
    mom_delta_pct: momDeltaPct,
    billed_tech_mtd_paise: billedMtd,
    billed_window_paise: billedWindowPaise,
    excluded: excluded.sort((a, b) => b.paise - a.paise),
    excluded_window_paise: excludedWindowPaise,
    undated_invoices: undatedInvoices,
    undated_paise: undatedPaise,
    no_vendor_paise: noVendorPaise,
    no_vendor_invoices: noVendorInvoices,
    ai_cost_window_paise: Number(aiTotal?.cost_cents ?? 0),
    ai_calls_window: Number(aiTotal?.calls ?? 0),
    vendors,
    credits,
    current_month: currentMonth,
    window,
    tech_filter_column: column,
  };
}

/**
 * The invoices behind one month's burn bar.
 *
 * Same scope as the burn query — `bucket`/`department` = 'tech', approved, same
 * effective date — so the rows returned here always sum to the bar that was
 * clicked. Anything else would be a drill-down that disagrees with the number
 * it drilled into.
 */
export async function getSpendBreakdown(
  month: string,
): Promise<BreakdownRow[]> {
  const column = await techFilterColumn();
  if (!column) return [];

  // Upper-bounded at today for the CURRENT month, matching resolveSpendWindow()
  // and the burn query. Without it, an invoice post-dated later this month
  // appeared in the drill-down but not in the bar it was drilled into — a
  // breakdown that exceeds its own total.
  const today = istDay();

  const result = await rows(sql`
    SELECT id::text                        AS id,
           vendor,
           invoice_number,
           description,
           ${EFFECTIVE_DATE}::text         AS effective_date,
           COALESCE(amount, 0)::numeric    AS inr
    FROM expense_submissions
    WHERE ${sql.raw(column)} = 'tech' AND status = 'approved'
      AND TO_CHAR(${EFFECTIVE_DATE}, 'YYYY-MM') = ${month}
      AND ${EFFECTIVE_DATE} <= ${today}::date
    ORDER BY ${EFFECTIVE_DATE} DESC, amount DESC
  `);

  return result.map((r) => {
    const raw = r.vendor == null ? null : String(r.vendor);
    const description = r.description == null ? null : String(r.description);
    const verdict = classifyTechSpend({ vendor: raw, description });
    return {
      id: String(r.id),
      vendor: raw,
      vendor_label: raw ? (canonicalVendor(raw)?.label ?? raw) : null,
      invoice_number: r.invoice_number == null ? null : String(r.invoice_number),
      description,
      effective_date:
        r.effective_date == null ? null : String(r.effective_date).slice(0, 10),
      paise: paise(r.inr),
      included: verdict.include,
      reason_label: REASON_LABELS[verdict.reason],
      explanation: verdict.explanation,
    };
  });
}
