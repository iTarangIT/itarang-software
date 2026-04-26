/**
 * Tenant resolution for the NBFC dashboard.
 *
 * Phase A: resolves via NBFC_DEMO_TENANT_SLUG env var, falls back to the first
 * active tenant in the DB. This is a development shortcut so we can render the
 * dashboard before NBFC partner auth is wired.
 *
 * Phase C: replace this with a Supabase-auth-driven resolver that reads the
 * `nbfc_users` join table for the current session user.
 */
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { nbfcLoans, nbfcTenants } from "@/lib/db/schema";

export interface TenantContext {
  id: string;
  slug: string;
  display_name: string;
  contact_email: string | null;
  aum_inr: string | null;
  active_loans: number;
}

let cached: { ctx: TenantContext; expiresAt: number } | null = null;

export async function getCurrentTenant(): Promise<TenantContext> {
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  const slug = process.env.NBFC_DEMO_TENANT_SLUG;
  let row: typeof nbfcTenants.$inferSelect | undefined;

  if (slug) {
    const rows = await db
      .select()
      .from(nbfcTenants)
      .where(and(eq(nbfcTenants.slug, slug), eq(nbfcTenants.is_active, true)))
      .limit(1);
    row = rows[0];
  }

  if (!row) {
    const rows = await db
      .select()
      .from(nbfcTenants)
      .where(eq(nbfcTenants.is_active, true))
      .limit(1);
    row = rows[0];
  }

  if (!row) {
    throw new Error(
      "No NBFC tenant found. Seed at least one row in nbfc_tenants (see scripts/seed-nbfc-demo.ts) or set NBFC_DEMO_TENANT_SLUG.",
    );
  }

  const ctx: TenantContext = {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    contact_email: row.contact_email,
    aum_inr: row.aum_inr,
    active_loans: row.active_loans,
  };
  cached = { ctx, expiresAt: Date.now() + 60_000 };
  return ctx;
}

/**
 * Returns the loan slice for the given tenant, shaped for the risk evaluators.
 */
export async function getTenantLoanSlice(tenantId: string) {
  const rows = await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      emi_amount: nbfcLoans.emi_amount,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, tenantId), eq(nbfcLoans.is_active, true)));

  return rows.map((r) => ({
    loan_application_id: r.loan_application_id,
    vehicleno: r.vehicleno,
    current_dpd: r.current_dpd,
    emi_amount: r.emi_amount != null ? Number(r.emi_amount) : null,
    outstanding_amount: r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
  }));
}
