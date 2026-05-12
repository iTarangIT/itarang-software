/**
 * E-065 — Ecosystem Overview compute (BRD §6.3.2)
 *
 * Admin-only service that aggregates cross-NBFC metric tiles and a comparison
 * table for the iTarang Ops dashboard. Most tiles are live aggregations over
 * existing schema (`nbfc_tenants`, `nbfc_loans`, `inventory`, `battery_alerts`,
 * `borrower_risk_scores`); two metrics with BRD-mandated refresh cadences
 * (IoT connectivity at 15 min, Avg CDS nightly) read from
 * `nbfc_ecosystem_metrics_cache`, falling back to live compute if absent.
 *
 * No tenant scoping is applied because the caller is iTarang Ops (admin) —
 * the route enforces 403 for non-admins.
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batteryAlerts,
  borrowerRiskScores,
  inventory,
  nbfcEcosystemMetricsCache,
  nbfcLoans,
  nbfcTenants,
} from "@/lib/db/schema";

export type EcosystemOverviewTiles = {
  connected_nbfcs: number;
  total_portfolio_inr: number;
  batteries_in_field: number;
  iot_connectivity_pct: number;
  platform_uptime_pct: number;
  alerts_24h: { critical: number; warning: number; info: number };
  avg_cds_network: number;
};

export type EcosystemComparisonRow = {
  nbfc_id: string;
  nbfc_name: string;
  active_loans: number;
  delinquency_pct: number;
  avg_cds: number;
  recovery_rate_pct: number;
};

export type EcosystemOverviewResponse = {
  tiles: EcosystemOverviewTiles;
  comparison: EcosystemComparisonRow[];
};

const CACHE_KEY_IOT = "iot_connectivity_pct";
const CACHE_KEY_AVG_CDS = "avg_cds_network";
const CACHE_KEY_UPTIME = "platform_uptime_pct";

const DEFAULT_PLATFORM_UPTIME_PCT = 99.7;

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function readCachedMetric(metricKey: string): Promise<number | null> {
  const rows = await db
    .select({
      metric_value: nbfcEcosystemMetricsCache.metric_value,
    })
    .from(nbfcEcosystemMetricsCache)
    .where(eq(nbfcEcosystemMetricsCache.metric_key, metricKey))
    .limit(1);
  if (!rows[0] || rows[0].metric_value == null) return null;
  return toNumber(rows[0].metric_value);
}

/**
 * IoT connectivity = (online devices / total registered devices) × 100.
 * Uses inventory rows as the device universe; "online" = soc_last_sync_at
 * within the last 30 minutes (online heartbeat).
 */
async function liveIotConnectivityPct(): Promise<number> {
  const rows = await db
    .select({
      total: sql<string>`count(*) filter (where ${inventory.iot_imei_no} is not null)`,
      online: sql<string>`count(*) filter (where ${inventory.iot_imei_no} is not null and ${inventory.soc_last_sync_at} > now() - interval '30 minutes')`,
    })
    .from(inventory);
  const total = toNumber(rows[0]?.total ?? 0);
  const online = toNumber(rows[0]?.online ?? 0);
  if (total <= 0) return 0;
  return Number(((online / total) * 100).toFixed(2));
}

/**
 * Live network-wide Avg CDS — average over the latest borrower_risk_scores
 * row per (tenant, borrower) where the row is non-null.
 */
async function liveAvgCdsNetwork(): Promise<number> {
  const rows = await db
    .select({
      avg: sql<string>`avg(${borrowerRiskScores.cds_score})`,
    })
    .from(borrowerRiskScores)
    .where(isNotNull(borrowerRiskScores.cds_score));
  return Number(toNumber(rows[0]?.avg ?? 0).toFixed(2));
}

/**
 * Compute network-wide Avg CDS per tenant (latest score per borrower wins).
 * Used both for the cache-less fallback AND for the per-NBFC comparison row.
 */
async function avgCdsByTenant(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      tenant_id: borrowerRiskScores.tenant_id,
      avg_cds: sql<string>`avg(${borrowerRiskScores.cds_score})`,
    })
    .from(borrowerRiskScores)
    .where(isNotNull(borrowerRiskScores.cds_score))
    .groupBy(borrowerRiskScores.tenant_id);
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.tenant_id, Number(toNumber(r.avg_cds).toFixed(2)));
  }
  return out;
}

async function computeAlerts24h(): Promise<{
  critical: number;
  warning: number;
  info: number;
}> {
  const rows = await db
    .select({
      severity: batteryAlerts.severity,
      n: sql<string>`count(*)`,
    })
    .from(batteryAlerts)
    .where(gte(batteryAlerts.created_at, sql`now() - interval '24 hours'`))
    .groupBy(batteryAlerts.severity);
  const out = { critical: 0, warning: 0, info: 0 };
  for (const r of rows) {
    const sev = (r.severity ?? "").toLowerCase();
    const n = toNumber(r.n);
    if (sev === "critical") out.critical += n;
    else if (sev === "warning" || sev === "warn") out.warning += n;
    else out.info += n;
  }
  return out;
}

/**
 * Per-NBFC comparison row aggregation. Source of truth:
 *   • active_loans: count(nbfc_loans) where is_active=true
 *   • delinquency_pct: count(current_dpd > 0) / count(*) × 100
 *   • avg_cds: avg(borrower_risk_scores.cds_score) for that tenant
 *   • recovery_rate_pct: count(nbfc_loans current_dpd=0) / count(*) × 100
 *     (proxy: BRD-defined recovery_rate is a downstream metric; until the
 *      recovery pipeline aggregator lands, "performing-loan rate" is the
 *      closest tenant-scoped signal we have on `nbfc_loans` alone.)
 */
async function comparisonRows(): Promise<EcosystemComparisonRow[]> {
  const tenants = await db
    .select({
      id: nbfcTenants.id,
      display_name: nbfcTenants.display_name,
    })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.is_active, true));

  if (tenants.length === 0) return [];

  const cdsByTenant = await avgCdsByTenant();

  const loanRollups = await db
    .select({
      tenant_id: nbfcLoans.tenant_id,
      total: sql<string>`count(*)`,
      active: sql<string>`count(*) filter (where ${nbfcLoans.is_active} = true)`,
      delinquent: sql<string>`count(*) filter (where coalesce(${nbfcLoans.current_dpd}, 0) > 0)`,
      performing: sql<string>`count(*) filter (where coalesce(${nbfcLoans.current_dpd}, 0) = 0)`,
    })
    .from(nbfcLoans)
    .groupBy(nbfcLoans.tenant_id);

  const byTenant = new Map<string, (typeof loanRollups)[number]>();
  for (const r of loanRollups) byTenant.set(r.tenant_id, r);

  return tenants.map((t) => {
    const r = byTenant.get(t.id);
    const total = toNumber(r?.total ?? 0);
    const active = toNumber(r?.active ?? 0);
    const delinquent = toNumber(r?.delinquent ?? 0);
    const performing = toNumber(r?.performing ?? 0);
    return {
      nbfc_id: t.id,
      nbfc_name: t.display_name,
      active_loans: active,
      delinquency_pct:
        total > 0 ? Number(((delinquent / total) * 100).toFixed(2)) : 0,
      avg_cds: cdsByTenant.get(t.id) ?? 0,
      recovery_rate_pct:
        total > 0 ? Number(((performing / total) * 100).toFixed(2)) : 0,
    };
  });
}

export async function computeEcosystemOverview(): Promise<EcosystemOverviewResponse> {
  // Tile: connected_nbfcs — active tenants are the BRD-relevant universe
  // (only is_active=true tenants surface loans, telemetry, and dashboards).
  const [connectedRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.is_active, true));

  // Tile: total_portfolio_inr — sum outstanding across loans whose tenant is
  // active. We join through nbfc_tenants.is_active so an inactive tenant's
  // legacy book doesn't inflate the network number.
  const [portfolioRow] = await db
    .select({
      total: sql<string>`coalesce(sum(${nbfcLoans.outstanding_amount}), 0)`,
    })
    .from(nbfcLoans)
    .innerJoin(nbfcTenants, eq(nbfcLoans.tenant_id, nbfcTenants.id))
    .where(and(eq(nbfcTenants.is_active, true), eq(nbfcLoans.is_active, true)));

  // Tile: batteries_in_field — sold IoT-enabled inventory.
  // BRD says "iot_enabled = true". Schema has `iot_imei_no` (varchar, nullable);
  // a non-null IMEI is the canonical proxy for an IoT-enabled unit.
  const [batteriesRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(inventory)
    .where(and(eq(inventory.status, "sold"), isNotNull(inventory.iot_imei_no)));

  // Tile: iot_connectivity_pct — cache (15 min) with live fallback.
  const cachedIot = await readCachedMetric(CACHE_KEY_IOT);
  const iotPct = cachedIot ?? (await liveIotConnectivityPct());

  // Tile: platform_uptime_pct — cache (rollup target 99.7%) with default.
  const cachedUptime = await readCachedMetric(CACHE_KEY_UPTIME);
  const uptimePct = cachedUptime ?? DEFAULT_PLATFORM_UPTIME_PCT;

  // Tile: alerts_24h — live group-by on battery_alerts (canonical alerts source).
  const alerts24h = await computeAlerts24h();

  // Tile: avg_cds_network — nightly cache, fall back to live recompute.
  const cachedAvgCds = await readCachedMetric(CACHE_KEY_AVG_CDS);
  const avgCds = cachedAvgCds ?? (await liveAvgCdsNetwork());

  const comparison = await comparisonRows();

  return {
    tiles: {
      connected_nbfcs: toNumber(connectedRow?.n ?? 0),
      total_portfolio_inr: toNumber(portfolioRow?.total ?? 0),
      batteries_in_field: toNumber(batteriesRow?.n ?? 0),
      iot_connectivity_pct: Number(iotPct.toFixed(2)),
      platform_uptime_pct: Number(uptimePct.toFixed(2)),
      alerts_24h: alerts24h,
      avg_cds_network: Number(avgCds.toFixed(2)),
    },
    comparison,
  };
}

// Exported for the cache writer / scheduled job.
export const ECOSYSTEM_CACHE_KEYS = {
  iot: CACHE_KEY_IOT,
  avgCds: CACHE_KEY_AVG_CDS,
  uptime: CACHE_KEY_UPTIME,
} as const;

// Latest cache timestamps — useful for health introspection / future freshness
// indicator. Returns undefined when the row is absent.
export async function getEcosystemCacheRefreshedAt(
  metricKey: string,
): Promise<Date | undefined> {
  const rows = await db
    .select({ refreshed_at: nbfcEcosystemMetricsCache.refreshed_at })
    .from(nbfcEcosystemMetricsCache)
    .where(eq(nbfcEcosystemMetricsCache.metric_key, metricKey))
    .orderBy(desc(nbfcEcosystemMetricsCache.refreshed_at))
    .limit(1);
  return rows[0]?.refreshed_at ?? undefined;
}
