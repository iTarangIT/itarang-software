/**
 * Portfolio data freshness (E-027 — BRD §6.1.3)
 *
 * Computes the most recent CDS computed_at and the most recent telemetry
 * ingestion timestamp for a tenant. is_stale is true when EITHER timestamp is
 * older than 24 hours OR is missing entirely (no rows yet for this tenant) —
 * the badge interprets a missing timestamp as a sync issue, which is what the
 * BRD's "Data may be outdated — IoT sync issue" copy describes.
 *
 * Tenant scoping is enforced in the where-clauses; the route layer additionally
 * gates access via requireNbfcAccess().
 */
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { borrowerRiskScores, telemetryIngestionLog } from "@/lib/db/schema";

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

  const [telemetryRow] = await db
    .select({ ingested_at: telemetryIngestionLog.ingested_at })
    .from(telemetryIngestionLog)
    .where(eq(telemetryIngestionLog.tenant_id, tenantId))
    .orderBy(desc(telemetryIngestionLog.ingested_at))
    .limit(1);

  const cdsAt = cdsRow?.computed_at ?? null;
  const telAt = telemetryRow?.ingested_at ?? null;

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
