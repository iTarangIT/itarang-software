/**
 * GET /api/nbfc/leads — Lead Intelligence listing for the NBFC portal (E-028).
 *
 * Returns leads associated with the calling NBFC tenant. Read-only surface;
 * mutating verbs return 405. Per BRD §6.1.4 a lead appears here when a
 * loan_sanctions row carries `nbfc_id = tenant.id`.
 *
 * Schema gap-tolerant: this unit was audited (verdict=audited) with the
 * understanding that several reuse columns (loan_sanctions.nbfc_id,
 * loan_sanctions.disbursed_at, dealers table, borrower_risk_scores table,
 * emi_schedules table) are still pending in upstream gap-fix units. The
 * implementation degrades gracefully when columns/tables are absent — the
 * route returns a well-formed empty page instead of crashing.
 *
 * Auth gating mirrors /api/nbfc/iot/fleet — getCurrentTenant() then
 * requireNbfcAccess(tenant.id), with UNAUTHORIZED→401 / FORBIDDEN→403 / 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  status: z
    .enum(["sanctioned", "dealer_approved", "disbursed", "active", "closed", "overdue"])
    .optional(),
  geography: z.string().optional(),
  product: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

interface RawRow {
  lead_reference_id: string | null;
  customer_name: string | null;
  dealer_name: string | null;
  battery_serial: string | null;
  loan_amount: string | number | null;
  loan_file_number: string | null;
  status: string | null;
  cds_score: string | number | null;
  next_due_date: string | null;
  days_overdue: string | number | null;
}

/**
 * Compute the BRD-spec colour band from a CDS score.
 *   < 40   → 'green'
 *   40-70  → 'amber'
 *   > 70   → 'red'
 */
function cdsBand(score: number): "green" | "amber" | "red" {
  if (score < 40) return "green";
  if (score <= 70) return "amber";
  return "red";
}

/**
 * Probe whether a column exists on a table. Used so missing upstream-gap
 * columns (loan_sanctions.nbfc_id, etc.) don't crash the endpoint at runtime.
 */
async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
      LIMIT 1
    `)) as unknown as Array<{ "?column?": number } | Record<string, unknown>>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table} LIMIT 1
    `)) as unknown as Array<unknown>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 422 },
      );
    }
    const q = parsed.data;
    const offset = (q.page - 1) * q.page_size;

    // Tenant scoping: the BRD requires loan_sanctions.nbfc_id = tenant.id.
    // If that column is not yet present (G-03), there is no safe way to scope,
    // so we return an empty page rather than leaking cross-tenant data.
    const hasNbfcId = await columnExists("loan_sanctions", "nbfc_id");
    if (!hasNbfcId) {
      return NextResponse.json({
        items: [],
        page: q.page,
        page_size: q.page_size,
        total: 0,
      });
    }

    const hasDisbursedAt = await columnExists("loan_sanctions", "disbursed_at");
    const hasDealersTable = await tableExists("dealers");
    const hasRiskTable = await tableExists("borrower_risk_scores");
    const hasEmiTable = await tableExists("emi_schedules");

    const dealerNameSelect = hasDealersTable
      ? sql`COALESCE(d.name, '')`
      : sql`COALESCE(l.business_name, l.full_name, '')`;
    const dealerJoin = hasDealersTable
      ? sql`LEFT JOIN dealers d ON d.id::text = l.dealer_id`
      : sql``;

    const cdsScoreSelect = hasRiskTable
      ? sql`COALESCE(brs.cds_score, 0)`
      : sql`0`;
    const riskJoin = hasRiskTable
      ? sql`LEFT JOIN borrower_risk_scores brs ON brs.loan_sanction_id = ls.id`
      : sql``;

    const emiCols = hasEmiTable
      ? sql`(SELECT MIN(es.due_date) FROM emi_schedules es WHERE es.loan_sanction_id = ls.id AND es.paid_at IS NULL)`
      : sql`NULL::timestamptz`;
    const emiOverdueCol = hasEmiTable
      ? sql`(SELECT GREATEST(0, EXTRACT(DAY FROM (now() - MIN(es.due_date)))::int)
              FROM emi_schedules es WHERE es.loan_sanction_id = ls.id AND es.paid_at IS NULL AND es.due_date < now())`
      : sql`0`;

    const dateColumn = hasDisbursedAt ? sql`ls.disbursed_at` : sql`ls.sanctioned_at`;

    // Build where clauses
    const whereParts: ReturnType<typeof sql>[] = [sql`ls.nbfc_id = ${tenant.id}`];
    if (q.status) whereParts.push(sql`ls.status = ${q.status}`);
    if (q.geography) {
      whereParts.push(
        sql`(LOWER(COALESCE(l.state,'')) = LOWER(${q.geography}) OR LOWER(COALESCE(l.city,'')) = LOWER(${q.geography}))`,
      );
    }
    if (q.product) {
      whereParts.push(sql`COALESCE(l.product_category_id, '') = ${q.product}`);
    }
    if (q.date_from) {
      whereParts.push(sql`${dateColumn} >= ${q.date_from}::timestamptz`);
    }
    if (q.date_to) {
      whereParts.push(sql`${dateColumn} <= ${q.date_to}::timestamptz`);
    }

    const whereClause = whereParts.reduce(
      (acc, part, i) => (i === 0 ? part : sql`${acc} AND ${part}`),
      sql``,
    );

    let rows: RawRow[] = [];
    let total = 0;
    try {
      const result = (await db.execute(sql`
        SELECT
          l.reference_id      AS lead_reference_id,
          l.full_name         AS customer_name,
          ${dealerNameSelect} AS dealer_name,
          COALESCE(inv.serial_number, '') AS battery_serial,
          ls.loan_amount      AS loan_amount,
          ls.loan_file_number AS loan_file_number,
          ls.status           AS status,
          ${cdsScoreSelect}   AS cds_score,
          ${emiCols}          AS next_due_date,
          ${emiOverdueCol}    AS days_overdue
        FROM loan_sanctions ls
        JOIN leads l ON l.id = ls.lead_id
        LEFT JOIN inventory inv ON inv.linked_lead_id = l.id
        ${dealerJoin}
        ${riskJoin}
        WHERE ${whereClause}
        ORDER BY ls.created_at DESC
        LIMIT ${q.page_size} OFFSET ${offset}
      `)) as unknown as RawRow[];
      rows = result;

      const countResult = (await db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM loan_sanctions ls
        JOIN leads l ON l.id = ls.lead_id
        WHERE ${whereClause}
      `)) as unknown as Array<{ total: number }>;
      total = countResult[0]?.total ?? 0;
    } catch {
      // Schema gap encountered at query time — return empty rather than 500.
      rows = [];
      total = 0;
    }

    const items = rows.map((r) => {
      const score = Number(r.cds_score ?? 0);
      const overdue = Number(r.days_overdue ?? 0);
      return {
        lead_reference_id: r.lead_reference_id ?? "",
        customer_name: r.customer_name ?? "",
        dealer_name: r.dealer_name ?? "",
        battery_serial: r.battery_serial ?? "",
        loan_amount: r.loan_amount != null ? Number(r.loan_amount) : 0,
        loan_file_number: r.loan_file_number ?? "",
        status: r.status ?? "",
        cds_score: score,
        cds_band: cdsBand(score),
        next_due_date: r.next_due_date ?? null,
        days_overdue: overdue,
      };
    });

    return NextResponse.json({
      items,
      page: q.page,
      page_size: q.page_size,
      total,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

// Read-only surface — mutating verbs are explicitly rejected with 405.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED: NBFC lead intelligence is read-only" },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function PATCH() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED: NBFC lead intelligence is read-only" },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function PUT() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED: NBFC lead intelligence is read-only" },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function DELETE() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED: NBFC lead intelligence is read-only" },
    { status: 405, headers: { Allow: "GET" } },
  );
}
