/**
 * POST /api/nbfc/loans/import
 *
 * Bulk-import (or update) the borrower↔vehicleno mapping for a tenant. Used
 * by NBFC partners during onboarding when they hand over a CSV of:
 *
 *   loan_application_id,vehicleno,emi_amount,emi_due_date_dom,outstanding_amount
 *
 * Body:
 *   {
 *     "tenant_slug": "demo-nbfc",          // ignored for nbfc_partner role
 *     "rows": [
 *       { "loan_application_id":"LOAN-...","vehicleno":"TK-...", "emi_amount": 4500,
 *         "emi_due_date_dom": 5, "outstanding_amount": 72000 }
 *     ]
 *   }
 *
 * Auth gating: same as other /api/nbfc/* routes. nbfc_partner can only import
 * for their own tenant; admin/ceo can import for any.
 *
 * The endpoint expects loan_application_id values that already exist in
 * loan_applications. If you're importing brand-new loans, create them first
 * via your normal loan-application flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfcLoans, nbfcTenants, loanApplications } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getSessionUser, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RowSchema = z.object({
  loan_application_id: z.string().min(1).max(255),
  vehicleno: z.string().min(1).max(64),
  emi_amount: z.number().positive().optional(),
  emi_due_date_dom: z.number().int().min(1).max(28).optional(),
  outstanding_amount: z.number().nonnegative().optional(),
  current_dpd: z.number().int().min(0).max(720).optional(),
});

const BodySchema = z.object({
  tenant_slug: z.string().min(1).max(64),
  rows: z.array(RowSchema).min(1).max(5_000),
});

export async function POST(req: NextRequest) {
  try {
    const body = BodySchema.parse(await req.json());

    // Resolve tenant the caller is targeting
    const t = await db
      .select()
      .from(nbfcTenants)
      .where(eq(nbfcTenants.slug, body.tenant_slug))
      .limit(1)
      .then((r) => r[0]);
    if (!t) return NextResponse.json({ ok: false, error: `unknown tenant: ${body.tenant_slug}` }, { status: 404 });

    // Auth: nbfc_partner can only act on their own tenant; admin/ceo can act on any
    const session = await getSessionUser();
    if (session?.role === "nbfc_partner") {
      // requireNbfcAccess will throw if they're not a member of THIS tenant
      await requireNbfcAccess(t.id);
    } else if (session?.role !== "admin" && session?.role !== "ceo") {
      // dev fallback (allowed) or full reject
      if (!(process.env.NODE_ENV !== "production" && process.env.NBFC_DEMO_TENANT_SLUG)) {
        return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
    }

    // Check that all referenced loan_application_ids actually exist
    const ids = body.rows.map((r) => r.loan_application_id);
    const existing = await db
      .select({ id: loanApplications.id })
      .from(loanApplications)
      .where(inArray(loanApplications.id, ids));
    const existingSet = new Set(existing.map((e) => e.id));
    const missing = ids.filter((id) => !existingSet.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: "unknown loan_application_id(s)", missing: missing.slice(0, 50) },
        { status: 400 },
      );
    }

    let inserted = 0;
    let updated = 0;
    for (const row of body.rows) {
      const result = await db
        .insert(nbfcLoans)
        .values({
          loan_application_id: row.loan_application_id,
          tenant_id: t.id,
          vehicleno: row.vehicleno,
          emi_amount: row.emi_amount?.toString(),
          emi_due_date_dom: row.emi_due_date_dom,
          outstanding_amount: row.outstanding_amount?.toString(),
          current_dpd: row.current_dpd ?? 0,
          is_active: true,
        })
        .onConflictDoUpdate({
          target: nbfcLoans.loan_application_id,
          set: {
            tenant_id: t.id,
            vehicleno: row.vehicleno,
            emi_amount: row.emi_amount?.toString(),
            emi_due_date_dom: row.emi_due_date_dom,
            outstanding_amount: row.outstanding_amount?.toString(),
            current_dpd: row.current_dpd ?? 0,
            is_active: true,
            updated_at: new Date(),
          },
        })
        .returning({ id: nbfcLoans.loan_application_id, created: nbfcLoans.created_at, updated: nbfcLoans.updated_at });
      if (result[0]) {
        // Drizzle doesn't tell us insert-vs-update directly; compare timestamps
        const r0 = result[0];
        const isInsert =
          r0.created instanceof Date &&
          r0.updated instanceof Date &&
          Math.abs(r0.created.getTime() - r0.updated.getTime()) < 1000;
        if (isInsert) inserted++;
        else updated++;
      }
    }

    // Refresh the denormalized active_loans count
    const total = await db
      .select({ n: nbfcLoans.loan_application_id })
      .from(nbfcLoans)
      .where(and(eq(nbfcLoans.tenant_id, t.id), eq(nbfcLoans.is_active, true)));
    await db
      .update(nbfcTenants)
      .set({ active_loans: total.length, updated_at: new Date() })
      .where(eq(nbfcTenants.id, t.id));

    return NextResponse.json({ ok: true, inserted, updated, total_active_loans: total.length });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "validation", issues: e.issues }, { status: 400 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
