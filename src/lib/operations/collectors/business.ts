/**
 * Business numbers, mirrored from the CEO dashboard.
 *
 * The tech team's use for these is narrow and specific: a pipeline that breaks
 * after a deploy shows up here as a number going to zero, hours before anyone
 * in sales notices. That is why leads_created carries a warn threshold of 1 —
 * "zero leads created this month" mid-month is a broken ingest, not a quiet week.
 *
 * Every figure comes from @/lib/dashboard/ceoMetrics, which owns the filter
 * definitions (revenue excludes only void; outstanding also excludes draft).
 * Nothing is re-derived here — a mirror with its own opinion is not a mirror.
 *
 * MONEY IS INR PAISE in ops_metric_samples, but the CEO tiles work in rupees,
 * so the two money metrics are converted on the way in. The registry declares
 * them `inr_paise`; formatINR then divides by 100 to render.
 */

import { getCeoBusinessMetrics } from "@/lib/dashboard/ceoMetrics";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

const SOURCE = "business:mtd";

export const businessCollector: OpsCollector = {
  id: "business.mtd",
  label: "Business metrics (MTD)",
  // These move on a human timescale and several are full-table aggregates over
  // the CEO's tables. Every 15 minutes is far more resolution than a daily
  // snapshot needs and keeps the cost off the 60s tick.
  intervalMs: 15 * MINUTE,
  timeoutMs: 25_000,

  async run(): Promise<CollectedSample[]> {
    const m = await getCeoBusinessMetrics();

    return [
      { metric_key: "business.leads_created_mtd", source: SOURCE, value_num: m.leads_created },
      { metric_key: "business.leads_converted_mtd", source: SOURCE, value_num: m.leads_converted },
      { metric_key: "business.dealers_onboarded_mtd", source: SOURCE, value_num: m.dealers_onboarded },
      // Rupees → paise. Rounded, not truncated: a ₹0.005 rounding difference
      // repeated across a month's invoices is how a mirror drifts from its source.
      { metric_key: "business.revenue_mtd", source: SOURCE, value_num: Math.round(m.revenue * 100) },
      { metric_key: "business.outstanding", source: SOURCE, value_num: Math.round(m.outstanding * 100) },
      { metric_key: "business.buyback_submitted_mtd", source: SOURCE, value_num: m.buyback_submitted },
      { metric_key: "business.buyback_completed_mtd", source: SOURCE, value_num: m.buyback_completed },
      {
        metric_key: "business.active_iot_devices",
        source: SOURCE,
        value_num: m.active_iot_devices,
      },
    ];
  },
};
