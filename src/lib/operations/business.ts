/**
 * The read model behind /operations/business.
 *
 * Shows each number TWICE, on purpose:
 *
 *   live      — computed now, from @/lib/dashboard/ceoMetrics, i.e. the same
 *               definitions the CEO dashboard renders;
 *   collected — what the business collector last wrote to ops_metric_samples.
 *
 * The pair is the product. If they match, the mirror is healthy and the CEO
 * dashboard's numbers are reproducible. If they diverge, either the collector
 * has stopped (the sample is old) or something changed underneath it — and a
 * monitoring page that showed only one of the two could not tell you which.
 *
 * This is also what makes the phase's acceptance criterion checkable on screen
 * rather than by someone eyeballing two browser tabs.
 */

import {
  currentMonthWindow,
  getCeoBusinessMetrics,
  type CeoBusinessMetrics,
} from "@/lib/dashboard/ceoMetrics";

import { getMetric, severityFor, type MetricDef, type Severity } from "./registry";
import { bySourceKey, latestSamples } from "./samples";

const SOURCE = "business:mtd";

/** metric_key → the live field it mirrors, and whether it is money. */
const MIRROR: Array<{
  key: string;
  field: keyof CeoBusinessMetrics;
  money?: boolean;
}> = [
  { key: "business.leads_created_mtd", field: "leads_created" },
  { key: "business.leads_converted_mtd", field: "leads_converted" },
  { key: "business.dealers_onboarded_mtd", field: "dealers_onboarded" },
  { key: "business.revenue_mtd", field: "revenue", money: true },
  { key: "business.outstanding", field: "outstanding", money: true },
  { key: "business.buyback_submitted_mtd", field: "buyback_submitted" },
  { key: "business.buyback_completed_mtd", field: "buyback_completed" },
  { key: "business.active_iot_devices", field: "active_iot_devices" },
];

export interface BusinessRow {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  help?: string;
  /** Always in the metric's declared unit — paise for money. */
  live: number;
  collected: number | null;
  /** True when the collector's value differs from the live one. */
  drifted: boolean;
  severity: Severity;
  age_minutes: number | null;
}

export interface BusinessView {
  window: { startStr: string; endStr: string };
  rows: BusinessRow[];
  /** Minutes since the collector last wrote any business metric. */
  collected_age_minutes: number | null;
  /** True when nothing has been collected yet — a first-run state, not a fault. */
  never_collected: boolean;
}

export async function getBusinessView(): Promise<BusinessView> {
  const window = currentMonthWindow();

  const [live, samples] = await Promise.all([
    getCeoBusinessMetrics(window),
    latestSamples(
      MIRROR.map((m) => m.key),
      { maxAgeHours: 48 },
    ),
  ]);

  const index = bySourceKey(samples);

  const rows = MIRROR.map((mirror): BusinessRow | null => {
    const def = getMetric(mirror.key);
    if (!def) return null;

    // Money is stored in paise; the CEO aggregation returns rupees. Convert on
    // this side so `live` and `collected` are directly comparable and the
    // formatter has one unit to reason about.
    const liveValue = mirror.money
      ? Math.round(live[mirror.field] * 100)
      : live[mirror.field];

    const sample = index.get(`${mirror.key}|${SOURCE}`);
    const collected = sample?.value_num ?? null;

    return {
      key: mirror.key,
      label: def.label,
      unit: def.unit,
      help: def.help,
      live: liveValue,
      collected,
      drifted: collected != null && collected !== liveValue,
      // Judged on the LIVE value: the threshold is about the business, not
      // about how fresh our copy of it is. Staleness has its own indicator.
      severity: severityFor(def, liveValue),
      age_minutes: sample?.age_minutes ?? null,
    };
  }).filter((r): r is BusinessRow => r !== null);

  const ages = rows
    .map((r) => r.age_minutes)
    .filter((a): a is number => a != null);

  return {
    window: { startStr: window.startStr, endStr: window.endStr },
    rows,
    collected_age_minutes: ages.length > 0 ? Math.min(...ages) : null,
    never_collected: ages.length === 0,
  };
}
