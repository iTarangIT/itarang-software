/**
 * E-027 — Portfolio Data Freshness Badge API tests.
 *
 * AC1: GET /api/nbfc/portfolio/freshness returns 200 with cds_last_computed_at,
 *      telemetry_last_ingested_at, and is_stale boolean.
 * AC2: When the most recent CDS computed_at for the tenant is older than 24
 *      hours, is_stale is true.
 *
 * The route is auth-gated; we use the triple-guarded test bypass
 * (NODE_ENV != production AND NBFC_TEST_BYPASS_SECRET on server AND matching
 * x-nbfc-test-bypass header on request) to attach to a tenant.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, gte, sql as drizzleSql } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL must be set for E-027 API tests");
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e027-loop-bypass-secret";

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-tenant-id": opts.tenantId,
    "x-nbfc-test-user-id": opts.userId,
    "x-nbfc-test-user-role": opts.role,
  };
}

/**
 * Fresh test tenant so we don't pollute (or get polluted by) any other
 * tenant's borrower_risk_scores / telemetry_ingestion_log rows.
 */
const ctx: { tenantId: string } = { tenantId: "" };
const createdTenantSlugs: string[] = [];

test.beforeAll(async () => {
  const slug = `e027-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-027 Test NBFC ${slug}` })
    .returning();
  ctx.tenantId = row.id;
  createdTenantSlugs.push(slug);
});

test.afterAll(async () => {
  // Best-effort cleanup. Order matters: child rows before tenant row.
  await db
    .delete(schema.borrowerRiskScores)
    .where(eq(schema.borrowerRiskScores.tenant_id, ctx.tenantId));
  await db
    .delete(schema.telemetryIngestionLog)
    .where(eq(schema.telemetryIngestionLog.tenant_id, ctx.tenantId));
  await db.delete(schema.nbfcTenants).where(eq(schema.nbfcTenants.id, ctx.tenantId));
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe("E-027 — Portfolio Data Freshness Badge", () => {
  test("AC1: Freshness endpoint returns timestamps and is_stale flag", async ({ request }) => {
    // Seed FRESH rows — both within last hour.
    const now = new Date();
    await db.insert(schema.borrowerRiskScores).values({
      tenant_id: ctx.tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: "72.50",
      computed_at: now,
    });
    await db.insert(schema.telemetryIngestionLog).values({
      tenant_id: ctx.tenantId,
      battery_serial: `BAT-AC1-${randomUUID().slice(0, 6)}`,
      ingested_at: now,
    });

    const res = await request.get("/api/nbfc/portfolio/freshness", {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: "viewer",
      }),
    });
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("cds_last_computed_at");
    expect(body).toHaveProperty("telemetry_last_ingested_at");
    expect(body).toHaveProperty("is_stale");
    expect(typeof body.is_stale).toBe("boolean");
    expect(typeof body.cds_last_computed_at).toBe("string");
    expect(typeof body.telemetry_last_ingested_at).toBe("string");
    // Both ISO timestamps should parse.
    expect(Number.isFinite(new Date(body.cds_last_computed_at).getTime())).toBe(true);
    expect(Number.isFinite(new Date(body.telemetry_last_ingested_at).getTime())).toBe(true);
    // Fresh seed → not stale.
    expect(body.is_stale).toBe(false);

    // Cleanup AC1 seeds before AC2 runs.
    await db
      .delete(schema.borrowerRiskScores)
      .where(eq(schema.borrowerRiskScores.tenant_id, ctx.tenantId));
    await db
      .delete(schema.telemetryIngestionLog)
      .where(eq(schema.telemetryIngestionLog.tenant_id, ctx.tenantId));
  });

  test("AC2: is_stale becomes true when CDS data is older than 24h", async ({ request }) => {
    const now = new Date();
    const stale = new Date(now.getTime() - 26 * 60 * 60 * 1000); // 26h ago

    // Old CDS row.
    await db.insert(schema.borrowerRiskScores).values({
      tenant_id: ctx.tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: "65.00",
      computed_at: stale,
    });
    // Fresh telemetry — proves staleness comes from CDS specifically.
    await db.insert(schema.telemetryIngestionLog).values({
      tenant_id: ctx.tenantId,
      battery_serial: `BAT-AC2-${randomUUID().slice(0, 6)}`,
      ingested_at: now,
    });

    const res = await request.get("/api/nbfc/portfolio/freshness", {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: "viewer",
      }),
    });
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.is_stale).toBe(true);
    // The stale CDS timestamp should be returned (oldest of the two streams).
    expect(new Date(body.cds_last_computed_at).getTime()).toBeLessThan(
      now.getTime() - 24 * 60 * 60 * 1000,
    );
  });
});
