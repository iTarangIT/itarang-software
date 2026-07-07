/**
 * Portfolio data freshness (E-027 — BRD §6.1.3)
 *
 * Computes the most recent CDS computed_at and the most recent telemetry
 * contact for a tenant. is_stale is true when EITHER timestamp is older than
 * 24 hours OR is missing entirely — the badge interprets a missing timestamp as
 * a sync issue, which is what the BRD's "Data may be outdated — IoT sync issue"
 * copy describes.
 *
 * Telemetry freshness is read from the LIVE VPS `vehicle_state` (freshest of
 * last_seen / last_gps_at / last_battery_at) for the tenant's active vehicles —
 * the same source Battery Monitoring reads — NOT the CRM-side
 * `telemetry_ingestion_log`. That ledger is
 * only written by the device-push /api/iot/ingest path, which is unused in this
 * deployment (telemetry is read live from the VPS). Reading the empty ledger
 * made the badge report a sync issue even while the VPS was connected and
 * serving current data; sourcing freshness from the VPS makes the badge reflect
 * the telemetry actually on screen. If the VPS is unreachable we leave the
 * timestamp null → is_stale, which is honest: a down VPS genuinely is a sync
 * issue.
 *
 * Tenant scoping is enforced in the where-clauses; the route layer additionally
 * gates access via requireNbfcAccess().
 */
import { db } from "@/lib/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { borrowerRiskScores, nbfcLoans } from "@/lib/db/schema";
import { getFleetLatestTelemetryAt } from "@/lib/db/iot-queries";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface FreshnessResult {
  cds_last_computed_at: string | null;
  telemetry_last_ingested_at: string | null;
  is_stale: boolean;
}

export async function computePortfolioFreshness(
  tenantId: string,
  now: Date = new Date(),
): Promise<FreshnessResult> {
  const [cdsRow] = await db
    .select({ computed_at: borrowerRiskScores.computed_at })
    .from(borrowerRiskScores)
    .where(eq(borrowerRiskScores.tenant_id, tenantId))
    .orderBy(desc(borrowerRiskScores.computed_at))
    .limit(1);

  // Resolve the tenant's active vehicle set from nbfc_loans, then ask the VPS
  // for the freshest GPS contact across those vehicles.
  const loanRows = await db
    .select({ vehicleno: nbfcLoans.vehicleno })
    .from(nbfcLoans)
    .where(
      and(
        eq(nbfcLoans.tenant_id, tenantId),
        eq(nbfcLoans.is_active, true),
        isNotNull(nbfcLoans.vehicleno),
      ),
    );
  const vehiclenos = [
    ...new Set(loanRows.map((r) => r.vehicleno).filter((v): v is string => !!v)),
  ];

  let telAt: Date | null = null;
  try {
    telAt = await getFleetLatestTelemetryAt(vehiclenos);
  } catch {
    // VPS unreachable / not configured — we can't confirm telemetry is flowing,
    // so leave telAt null and let is_stale surface the amber badge.
    telAt = null;
  }

  const cdsAt = cdsRow?.computed_at ?? null;

  const isStale =
    !cdsAt ||
    !telAt ||
    now.getTime() - new Date(cdsAt).getTime() > STALE_THRESHOLD_MS ||
    now.getTime() - new Date(telAt).getTime() > STALE_THRESHOLD_MS;

  return {
    cds_last_computed_at: cdsAt ? new Date(cdsAt).toISOString() : null,
    telemetry_last_ingested_at: telAt ? new Date(telAt).toISOString() : null,
    is_stale: isStale,
  };
}
