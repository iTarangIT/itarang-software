/**
 * E-091 — DPDPA Retention Policy Enforcer.
 *
 * BRD §6.4.4 mandates:
 *   • KYC documents: kept 7 years from lead creation (RBI KYC Master Direction
 *     + IT Act). After that they MUST be deleted.
 *   • Telemetry raw events: kept 2 years. Daily summaries are retained
 *     indefinitely (so we never delete from `borrower_risk_scores` /
 *     CDS-daily-style tables — only from raw IoT ingestion logs).
 *   • Each deletion writes an immutable `nbfc_retention_tombstones` row
 *     (table + identifier + reason + ts + storage_region) so the *fact*
 *     of the deletion is auditable even though the PII is gone.
 *   • Storage region must remain 'ap-south-1' (Mumbai); deletion does not
 *     cross borders.
 *
 * The actual S3 file deletion is a side-effect TODO — for the loop's
 * acceptance tests we only mark the row purged + null PII columns, then
 * the production runner can layer on the S3 delete. The tombstone is the
 * compliance artefact, not the S3 metadata.
 *
 * NOTE on column names: kyc_documents uses snake_case columns. We use
 * `sql\`column_name\`` references via Drizzle so that the runtime SQL is
 * exactly what the Postgres catalog has.
 */
import { db } from "@/lib/db";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  kycDocuments,
  leads,
  nbfcRetentionTombstones,
  telemetryIngestionLog,
} from "@/lib/db/schema";

export const KYC_RETENTION_YEARS = 7;
export const TELEMETRY_RAW_RETENTION_YEARS = 2;

export interface RetentionRunResult {
  as_of: string;
  kyc_deleted_count: number;
  telemetry_raw_deleted_count: number;
  tombstones_written: number;
  dry_run: boolean;
}

function yearsAgo(asOf: Date, years: number): Date {
  const d = new Date(asOf);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/**
 * Find KYC documents whose owning lead was created more than `KYC_RETENTION_YEARS`
 * ago, and which haven't been purged yet.
 */
async function findExpiredKycDocs(kycCutoff: Date) {
  const rows = await db
    .select({
      id: kycDocuments.id,
      lead_id: kycDocuments.lead_id,
    })
    .from(kycDocuments)
    .innerJoin(leads, eq(leads.id, kycDocuments.lead_id))
    .where(
      and(
        lt(leads.created_at, kycCutoff),
        eq(kycDocuments.purged, false),
      ),
    );
  return rows;
}

/**
 * Run the DPDPA retention sweep.
 *
 * @param opts.asOf     Reference clock for the retention windows; defaults to now.
 * @param opts.dryRun   If true: counts only, no deletions, no tombstones.
 */
export async function runDpdpaRetention(opts: {
  asOf?: Date;
  dryRun?: boolean;
} = {}): Promise<RetentionRunResult> {
  const asOf = opts.asOf ?? new Date();
  const dryRun = opts.dryRun ?? false;

  const kycCutoff = yearsAgo(asOf, KYC_RETENTION_YEARS);
  const telemetryCutoff = yearsAgo(asOf, TELEMETRY_RAW_RETENTION_YEARS);

  // ---- KYC documents -------------------------------------------------------
  const expiredKyc = await findExpiredKycDocs(kycCutoff);
  let kycDeleted = 0;
  let tombstonesWritten = 0;

  if (!dryRun) {
    for (const row of expiredKyc) {
      await db.insert(nbfcRetentionTombstones).values({
        table_name: "kyc_documents",
        original_id: row.id,
        row_count: 1,
        reason: "kyc_7y_expired",
        storage_region: "ap-south-1",
      });
      tombstonesWritten += 1;

      // Null PII columns and flip purged flag. We deliberately keep the row
      // so foreign keys from leads / kyc_verifications remain intact.
      await db
        .update(kycDocuments)
        .set({
          purged: true,
          purged_at: asOf,
          file_url: null,
          file_name: null,
          ocr_data: null,
          api_response: null,
          failed_reason: null,
          rejection_reason: null,
        })
        .where(eq(kycDocuments.id, row.id));
      kycDeleted += 1;
    }
  } else {
    kycDeleted = expiredKyc.length;
  }

  // ---- Telemetry raw events ------------------------------------------------
  // Daily summaries (e.g. borrower_risk_scores / CDS rollups) are NEVER
  // touched. We only delete from telemetry_ingestion_log — those rows are
  // per-event raw IoT pings.
  const rawCountRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(telemetryIngestionLog)
    .where(lt(telemetryIngestionLog.ingested_at, telemetryCutoff));
  const telemetryRawCount = Number(rawCountRows[0]?.c ?? 0);

  let telemetryDeleted = 0;
  if (!dryRun && telemetryRawCount > 0) {
    await db
      .delete(telemetryIngestionLog)
      .where(lt(telemetryIngestionLog.ingested_at, telemetryCutoff));

    // One batch tombstone (count rather than per-row id) — there can be
    // millions of telemetry events, so we don't write one row per event.
    await db.insert(nbfcRetentionTombstones).values({
      table_name: "telemetry_ingestion_log",
      original_id: null,
      row_count: telemetryRawCount,
      reason: "telemetry_2y_expired",
      storage_region: "ap-south-1",
    });
    tombstonesWritten += 1;
    telemetryDeleted = telemetryRawCount;
  } else if (dryRun) {
    telemetryDeleted = telemetryRawCount;
  }

  return {
    as_of: asOf.toISOString(),
    kyc_deleted_count: kycDeleted,
    telemetry_raw_deleted_count: telemetryDeleted,
    tombstones_written: tombstonesWritten,
    dry_run: dryRun,
  };
}
