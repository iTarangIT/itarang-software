/**
 * Spend — the two halves that are supposed to agree.
 *
 *   METERED: what we consumed, from ai_call_logs. Trailing 30 days, overall and
 *            per provider.
 *   BILLED:  what we were actually invoiced, from expense_submissions where
 *            bucket='tech'. Month to date, overall and per vendor.
 *
 * They are collected separately and deliberately never reconciled here — the
 * page puts them side by side and lets a human see the gap. A collector that
 * "reconciled" them would have to pick a winner, and the whole point is that a
 * divergence is the signal.
 *
 * MONEY IS INR PAISE THROUGHOUT, matching ai_call_logs.*_cost_cents and the
 * `inr_paise` unit in registry.ts.
 *
 *   · ai_call_logs.total_cost_cents is ALREADY INR paise for every provider.
 *     src/lib/ai/elevenlabs/fetchCallCost.ts converts credits → INR directly
 *     because the account is invoiced in rupees. Never apply an FX rate to it.
 *   · expense_submissions.amount is ALREADY the INR-converted figure;
 *     original_amount + fx_rate are the audit trail of how it got there
 *     (Anthropic $200 × 94.26 → ₹18,852). Applying fx_rate again would
 *     multiply the bill by ~94.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { unavailableText } from "@/lib/operations/errors";
// techFilterColumn lives with the read model, not here: the page and the
// collector must resolve 'tech' the same way, and two copies of that decision
// would eventually disagree about which column to trust.
import { techFilterColumn } from "@/lib/operations/spend";
import { canonicalVendor } from "@/lib/operations/vendors";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

const rows = async (
  query: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>>> =>
  (await db.execute(query)) as unknown as Array<Record<string, unknown>>;

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Rupees (numeric) → integer paise, the unit every money metric is stored in. */
function rupeesToPaise(value: unknown): number | null {
  const n = num(value);
  return n == null ? null : Math.round(n * 100);
}

async function meteredSamples(): Promise<CollectedSample[]> {
  const samples: CollectedSample[] = [];

  // Trailing 30 days on ended_at — cost is per call, not per campaign, which is
  // the same column src/lib/campaigns/cost-analytics-query.ts filters on. E-210
  // added the index this relies on.
  //
  // Deliberately NOT joined to dialer_campaign_leads. That join is what made
  // the Cost Analytics dashboard read ~5x too low before May 2026: calls placed
  // outside a campaign, and campaign calls whose webhook dropped, have no DCL
  // row. Spend is spend regardless of where the call came from.
  const [total] = await rows(sql`
    SELECT
      COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
      COUNT(*)::int                              AS calls,
      COALESCE(SUM(call_duration), 0)::bigint    AS duration_s
    FROM ai_call_logs
    WHERE call_id IS NOT NULL
      AND ended_at > NOW() - INTERVAL '30 days'
  `);

  const cost = num(total?.cost_cents);
  const calls = num(total?.calls);

  if (cost != null) {
    samples.push({
      metric_key: "spend.ai_calls_cost_30d",
      source: "spend:all",
      value_num: cost,
      meta: { duration_s: num(total?.duration_s) },
    });
  }
  if (calls != null) {
    samples.push({
      metric_key: "spend.ai_calls_count_30d",
      source: "spend:all",
      value_num: calls,
    });
  }

  const perProvider = await rows(sql`
    SELECT
      provider,
      COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents,
      COUNT(*)::int                              AS calls,
      COALESCE(SUM(call_duration), 0)::bigint    AS duration_s
    FROM ai_call_logs
    WHERE call_id IS NOT NULL
      AND ended_at > NOW() - INTERVAL '30 days'
      AND provider IS NOT NULL
    GROUP BY provider
  `);

  for (const row of perProvider) {
    const provider = String(row.provider);
    samples.push({
      metric_key: "spend.provider_cost_30d",
      source: `provider:${provider}`.slice(0, 80),
      value_num: num(row.cost_cents) ?? 0,
      meta: {
        provider,
        calls: num(row.calls),
        duration_s: num(row.duration_s),
      },
    });
  }

  return samples;
}

async function billedSamples(): Promise<CollectedSample[]> {
  const column = await techFilterColumn();
  if (!column) return [];

  // Month to date in IST — the team's month, not UTC's. A bill dated the 1st at
  // 02:00 IST belongs to the new month, and UTC would file it under the old one.
  const scope = sql`
    WHERE ${sql.raw(column)} = 'tech'
      AND status = 'approved'
      AND COALESCE(expense_date, (approved_at AT TIME ZONE 'Asia/Kolkata')::date)
          >= DATE_TRUNC('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))::date
  `;

  const [total] = await rows(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS inr, COUNT(*)::int AS invoices
    FROM expense_submissions ${scope}
  `);

  const samples: CollectedSample[] = [
    {
      metric_key: "spend.billed_tech_mtd",
      source: "spend:tech",
      value_num: rupeesToPaise(total?.inr) ?? 0,
      meta: { invoices: num(total?.invoices), filter_column: column },
    },
  ];

  const perVendor = await rows(sql`
    SELECT vendor, COALESCE(SUM(amount), 0)::numeric AS inr, COUNT(*)::int AS invoices
    FROM expense_submissions ${scope}
      AND vendor IS NOT NULL
    GROUP BY vendor
  `);

  // Several invoice entities can collapse to one canonical vendor (a vendor
  // that bills from two legal entities, or a name typed inconsistently), so
  // accumulate rather than emitting one sample per raw name — two samples with
  // the same (metric_key, source) would just be two rows the page reads one of.
  const byVendor = new Map<
    string,
    { label: string; matched: boolean; paise: number; invoices: number; raw: string[] }
  >();

  for (const row of perVendor) {
    const raw = String(row.vendor);
    const vendor = canonicalVendor(raw);
    if (!vendor) continue;

    const entry = byVendor.get(vendor.id) ?? {
      label: vendor.label,
      matched: vendor.matched,
      paise: 0,
      invoices: 0,
      raw: [],
    };
    entry.paise += rupeesToPaise(row.inr) ?? 0;
    entry.invoices += num(row.invoices) ?? 0;
    if (!entry.raw.includes(raw)) entry.raw.push(raw);
    byVendor.set(vendor.id, entry);
  }

  for (const [id, entry] of byVendor) {
    samples.push({
      metric_key: "spend.billed_vendor_mtd",
      source: `vendor:${id}`.slice(0, 80),
      value_num: entry.paise,
      meta: {
        label: entry.label,
        matched: entry.matched,
        invoices: entry.invoices,
        // Which invoice entities rolled up here — the first thing you want when
        // a vendor's total looks wrong.
        entities: entry.raw.slice(0, 10),
      },
    });
  }

  return samples;
}

export const spendCollector: OpsCollector = {
  id: "spend.rollup",
  label: "AI spend & billed tech spend",
  // Neither half moves quickly: invoices arrive daily at best, and call costs
  // are backfilled asynchronously. Hourly is plenty and keeps a moderately
  // heavy aggregate off the 60s tick.
  intervalMs: 60 * MINUTE,
  timeoutMs: 25_000,

  async run(): Promise<CollectedSample[]> {
    // Independent halves: a missing expense_submissions column must not cost us
    // the AI numbers, which are the ones with a threshold on them.
    const [metered, billed] = await Promise.all([
      meteredSamples(),
      billedSamples().catch((e) => {
        return [
          {
            metric_key: "spend.billed_tech_mtd",
            source: "spend:tech",
            value_num: null,
            value_text: unavailableText(e),
          } satisfies CollectedSample,
        ];
      }),
    ]);

    return [...metered, ...billed];
  },
};
