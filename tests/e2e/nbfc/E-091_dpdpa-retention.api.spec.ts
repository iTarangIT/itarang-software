/**
 * E-091 — DPDPA retention enforcer API tests.
 *
 * AC1: dry_run=true returns counts > 0 for seeded expired data; nothing is
 *      actually deleted, no tombstones written.
 * AC2: dry_run=false writes one nbfc_retention_tombstones row per deleted
 *      KYC document with reason='kyc_7y_expired' + storage_region='ap-south-1'.
 * AC3: dry_run=false does NOT delete daily summary rows (borrower_risk_scores)
 *      — only telemetry_ingestion_log rows older than 2y are removed.
 * AC4: non-admin user gets 403.
 *
 * The test uses the triple-guarded NBFC test bypass to fabricate the actor
 * (the same idiom E-082 / E-090 use). Seeded rows are namespaced with the
 * test-run id so concurrent suites don't trip each other.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-091 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': opts.role,
  };
}

const RUN_ID = `e091-${Date.now()}-${randomUUID().slice(0, 6)}`;
const ctx: { tenantId: string } = { tenantId: '' };
const seededLeadIds: string[] = [];
const seededKycIds: string[] = [];
const seededTelemetryIds: string[] = [];
const seededRiskScoreIds: string[] = [];

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e091-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-091 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

async function seedExpiredKyc(label: string) {
  // Lead created 8 years ago (well past the 7y KYC retention window).
  const leadId = `${RUN_ID}-lead-${label}`;
  const eightYearsAgo = new Date();
  eightYearsAgo.setUTCFullYear(eightYearsAgo.getUTCFullYear() - 8);
  await db.insert(schema.leads).values({
    id: leadId,
    owner_name: `Retention test ${label}`,
    lead_source: 'database_upload',
    uploader_id: randomUUID(),
    created_at: eightYearsAgo,
  });
  seededLeadIds.push(leadId);

  const docId = `${RUN_ID}-kyc-${label}`;
  await db.insert(schema.kycDocuments).values({
    id: docId,
    lead_id: leadId,
    doc_type: 'aadhaar',
    file_url: `s3://kyc/${docId}.pdf`,
    file_name: `${docId}.pdf`,
    purged: false,
  });
  seededKycIds.push(docId);
  return { leadId, docId };
}

async function seedExpiredTelemetry(tenantId: string) {
  const threeYearsAgo = new Date();
  threeYearsAgo.setUTCFullYear(threeYearsAgo.getUTCFullYear() - 3);
  const [row] = await db
    .insert(schema.telemetryIngestionLog)
    .values({
      tenant_id: tenantId,
      battery_serial: `${RUN_ID}-bat`,
      ingested_at: threeYearsAgo,
    })
    .returning({ id: schema.telemetryIngestionLog.id });
  seededTelemetryIds.push(row.id);
  return row.id;
}

async function seedDailySummary(tenantId: string) {
  // borrower_risk_scores acts as the "daily telemetry summary" surface for
  // this codebase — it's the CDS rollup that must be retained indefinitely.
  // We use a deliberately-old computed_at to prove the retention sweep does
  // NOT touch summaries even when their timestamp is past the 2y window.
  const fourYearsAgo = new Date();
  fourYearsAgo.setUTCFullYear(fourYearsAgo.getUTCFullYear() - 4);
  const [row] = await db
    .insert(schema.borrowerRiskScores)
    .values({
      tenant_id: tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: '72.50',
      pci_score: '0.823',
      confidence: 'high',
      computed_at: fourYearsAgo,
    })
    .returning({ id: schema.borrowerRiskScores.id });
  seededRiskScoreIds.push(row.id);
  return row.id;
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
});

test.afterAll(async () => {
  // Clean up everything we seeded. Tombstones get cleaned by run-id prefix
  // on original_id (KYC) and by table_name + we filter by deleted_at recent.
  for (const id of seededKycIds) {
    await db.delete(schema.kycDocuments).where(eq(schema.kycDocuments.id, id)).catch(() => {});
  }
  for (const id of seededLeadIds) {
    await db.delete(schema.leads).where(eq(schema.leads.id, id)).catch(() => {});
  }
  for (const id of seededTelemetryIds) {
    await db
      .delete(schema.telemetryIngestionLog)
      .where(eq(schema.telemetryIngestionLog.id, id))
      .catch(() => {});
  }
  for (const id of seededRiskScoreIds) {
    await db
      .delete(schema.borrowerRiskScores)
      .where(eq(schema.borrowerRiskScores.id, id))
      .catch(() => {});
  }
  // Tombstones for KYC docs we created — filtered by original_id pattern.
  await db
    .delete(schema.nbfcRetentionTombstones)
    .where(like(schema.nbfcRetentionTombstones.original_id, `${RUN_ID}-%`))
    .catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-091 — DPDPA retention enforcer', () => {
  test('AC1: dry_run=true reports counts and mutates nothing', async ({ request }) => {
    const { docId } = await seedExpiredKyc('ac1');
    const telemetryId = await seedExpiredTelemetry(ctx.tenantId);

    const res = await request.post('/api/nbfc/dpdpa/retention/run', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: 'admin',
      }),
      data: { dry_run: true },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.kyc_deleted_count).toBeGreaterThanOrEqual(1);
    expect(body.telemetry_raw_deleted_count).toBeGreaterThanOrEqual(1);
    expect(body.tombstones_written).toBe(0);

    // The seeded KYC doc must still be unpurged after a dry run.
    const docRow = await db
      .select()
      .from(schema.kycDocuments)
      .where(eq(schema.kycDocuments.id, docId))
      .limit(1);
    expect(docRow[0].purged).toBe(false);
    expect(docRow[0].file_url).not.toBeNull();

    // Telemetry row must still exist.
    const telRow = await db
      .select()
      .from(schema.telemetryIngestionLog)
      .where(eq(schema.telemetryIngestionLog.id, telemetryId))
      .limit(1);
    expect(telRow.length).toBe(1);

    // No tombstone for this docId yet.
    const tombs = await db
      .select()
      .from(schema.nbfcRetentionTombstones)
      .where(eq(schema.nbfcRetentionTombstones.original_id, docId));
    expect(tombs.length).toBe(0);
  });

  test('AC2: dry_run=false writes a tombstone per KYC deletion with correct reason+region', async ({
    request,
  }) => {
    const { docId } = await seedExpiredKyc('ac2');

    const res = await request.post('/api/nbfc/dpdpa/retention/run', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: 'admin',
      }),
      data: { dry_run: false },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(false);
    expect(body.kyc_deleted_count).toBeGreaterThanOrEqual(1);
    expect(body.tombstones_written).toBeGreaterThanOrEqual(1);

    // Tombstone exists for this exact docId with the right metadata.
    const tombs = await db
      .select()
      .from(schema.nbfcRetentionTombstones)
      .where(
        and(
          eq(schema.nbfcRetentionTombstones.original_id, docId),
          eq(schema.nbfcRetentionTombstones.reason, 'kyc_7y_expired'),
        ),
      );
    expect(tombs.length).toBe(1);
    expect(tombs[0].storage_region).toBe('ap-south-1');
    expect(tombs[0].table_name).toBe('kyc_documents');

    // Doc itself is purged + PII nulled.
    const docRow = await db
      .select()
      .from(schema.kycDocuments)
      .where(eq(schema.kycDocuments.id, docId))
      .limit(1);
    expect(docRow[0].purged).toBe(true);
    expect(docRow[0].purged_at).not.toBeNull();
    expect(docRow[0].file_url).toBeNull();
    expect(docRow[0].file_name).toBeNull();
  });

  test('AC3: daily summaries are preserved; only raw events older than 2y are removed', async ({
    request,
  }) => {
    const summaryId = await seedDailySummary(ctx.tenantId);
    const telemetryId = await seedExpiredTelemetry(ctx.tenantId);

    const res = await request.post('/api/nbfc/dpdpa/retention/run', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: 'admin',
      }),
      data: { dry_run: false },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);

    // Daily summary row STILL exists (retention rule: indefinite for summaries).
    const summary = await db
      .select()
      .from(schema.borrowerRiskScores)
      .where(eq(schema.borrowerRiskScores.id, summaryId))
      .limit(1);
    expect(summary.length).toBe(1);

    // Raw telemetry row is GONE.
    const tel = await db
      .select()
      .from(schema.telemetryIngestionLog)
      .where(eq(schema.telemetryIngestionLog.id, telemetryId))
      .limit(1);
    expect(tel.length).toBe(0);

    // And a telemetry tombstone was written.
    const tombs = await db
      .select()
      .from(schema.nbfcRetentionTombstones)
      .where(
        and(
          eq(schema.nbfcRetentionTombstones.table_name, 'telemetry_ingestion_log'),
          eq(schema.nbfcRetentionTombstones.reason, 'telemetry_2y_expired'),
        ),
      );
    expect(tombs.length).toBeGreaterThanOrEqual(1);
  });

  test('AC4: non-admin user is rejected with 403', async ({ request }) => {
    const res = await request.post('/api/nbfc/dpdpa/retention/run', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: 'viewer',
      }),
      data: { dry_run: true },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');
  });
});
