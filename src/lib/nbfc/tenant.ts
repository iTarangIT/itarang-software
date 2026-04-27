/**
 * Tenant resolution for the NBFC dashboard.
 *
 * Resolution order (Phase C):
 *   1. The current authenticated user's nbfc_users row → that tenant
 *   2. If admin/ceo (no nbfc_users membership) AND request includes
 *      ?tenant=<slug> query param, use that
 *   3. Dev fallback: NBFC_DEMO_TENANT_SLUG env var
 *   4. Otherwise: throw — page must be rendered for an authenticated NBFC
 *      user or for an internal admin acting on behalf of one.
 *
 * `requireNbfcAccess(tenantId)` is the safety primitive every NBFC API route
 * should call. It throws (caught by the route handler → 403) unless the
 * current session is allowed to act on that tenant.
 */
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { nbfcLoans, nbfcTenants, nbfcUsers, users } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

export interface TenantContext {
  id: string;
  slug: string;
  display_name: string;
  contact_email: string | null;
  aum_inr: string | null;
  active_loans: number;
  /** How we resolved this tenant — for diagnostics/logging. */
  via: "session" | "admin_query_param" | "dev_env" | "first_active";
}

export interface SessionUser {
  id: string;
  email: string | null;
  role: string; // 'nbfc_partner' | 'admin' | 'ceo' | …
}

/**
 * Look up the current Supabase user + their CRM users.role. Returns null if
 * not authenticated.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Role is on app_metadata after login sync, with a DB fallback.
  const appRole = (user.app_metadata as { role?: string } | undefined)?.role;
  const userMetaRole = (user.user_metadata as { role?: string } | undefined)?.role;

  let role = (appRole ?? userMetaRole ?? "").toLowerCase();
  if (!role) {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    role = (rows[0]?.role ?? "user").toLowerCase();
  }
  return { id: user.id, email: user.email ?? null, role };
}

/**
 * Resolve the tenant the current request is for. See doc-block at top.
 */
export async function getCurrentTenant(opts?: { tenantSlugOverride?: string }): Promise<TenantContext> {
  const session = await getSessionUser();

  // 1. Authenticated NBFC partner → their first nbfc_users membership
  if (session && session.role === "nbfc_partner") {
    const rows = await db
      .select({
        id: nbfcTenants.id,
        slug: nbfcTenants.slug,
        display_name: nbfcTenants.displayName,
        contact_email: nbfcTenants.contactEmail,
        aum_inr: nbfcTenants.aumInr,
        active_loans: nbfcTenants.activeLoans,
      })
      .from(nbfcUsers)
      .innerJoin(nbfcTenants, eq(nbfcUsers.tenantId, nbfcTenants.id))
      .where(and(eq(nbfcUsers.userId, session.id), eq(nbfcTenants.isActive, true)))
      .limit(1);

    if (!rows[0]) {
      throw new Error(
        `User ${session.email} is role=nbfc_partner but has no nbfc_users membership. Run scripts/invite-nbfc-user.ts to assign a tenant.`,
      );
    }
    return { ...rows[0], via: "session" };
  }

  // 2. admin/ceo with explicit ?tenant=<slug> override
  if (
    session &&
    (session.role === "admin" || session.role === "ceo") &&
    opts?.tenantSlugOverride
  ) {
    const t = await tenantBySlug(opts.tenantSlugOverride);
    if (t) return { ...t, via: "admin_query_param" };
  }

  // 3. Dev fallback via env (used until you onboard a real partner)
  const slug = process.env.NBFC_DEMO_TENANT_SLUG;
  if (slug) {
    const t = await tenantBySlug(slug);
    if (t) return { ...t, via: "dev_env" };
  }

  // 4. First active tenant — last-resort safety net for dev
  const rows = await db
    .select()
    .from(nbfcTenants)
    .where(eq(nbfcTenants.isActive, true))
    .limit(1);
  if (rows[0]) {
    return {
      id: rows[0].id,
      slug: rows[0].slug,
      display_name: rows[0].displayName,
      contact_email: rows[0].contactEmail,
      aum_inr: rows[0].aumInr,
      active_loans: rows[0].activeLoans,
      via: "first_active",
    };
  }

  throw new Error(
    "No NBFC tenant resolved. Either log in as an nbfc_partner with a membership, or set NBFC_DEMO_TENANT_SLUG, or seed nbfc_tenants.",
  );
}

async function tenantBySlug(slug: string) {
  const rows = await db
    .select({
      id: nbfcTenants.id,
      slug: nbfcTenants.slug,
      display_name: nbfcTenants.displayName,
      contact_email: nbfcTenants.contactEmail,
      aum_inr: nbfcTenants.aumInr,
      active_loans: nbfcTenants.activeLoans,
    })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, slug), eq(nbfcTenants.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Throws unless the current session is allowed to act on `tenantId`.
 * Use at the top of every NBFC API handler that mutates or reads tenant data.
 *
 *  - nbfc_partner: must be a member via nbfc_users
 *  - admin / ceo:  always allowed (with audit log)
 *  - anyone else:  rejected
 *
 * In dev, when there's no session but NBFC_DEMO_TENANT_SLUG is set, we allow
 * the request. This is intentional so the dev server works without auth.
 */
export async function requireNbfcAccess(tenantId: string): Promise<SessionUser | { dev: true }> {
  const session = await getSessionUser();
  if (!session) {
    if (process.env.NODE_ENV !== "production" && process.env.NBFC_DEMO_TENANT_SLUG) {
      return { dev: true };
    }
    throw new Error("UNAUTHORIZED: no session");
  }
  if (session.role === "admin" || session.role === "ceo") return session;
  if (session.role !== "nbfc_partner") {
    throw new Error(`FORBIDDEN: role=${session.role} cannot access NBFC routes`);
  }
  // Verify membership
  const rows = await db
    .select({ id: nbfcUsers.tenantId })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.userId, session.id), eq(nbfcUsers.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new Error(`FORBIDDEN: user ${session.email} is not a member of tenant ${tenantId}`);
  return session;
}

/**
 * Returns the loan slice for the given tenant, shaped for the risk evaluators.
 */
export async function getTenantLoanSlice(tenantId: string) {
  const rows = await db
    .select({
      loan_application_id: nbfcLoans.loanApplicationId,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.currentDpd,
      emi_amount: nbfcLoans.emiAmount,
      outstanding_amount: nbfcLoans.outstandingAmount,
    })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenantId, tenantId), eq(nbfcLoans.isActive, true)));

  return rows.map((r) => ({
    loan_application_id: r.loan_application_id,
    vehicleno: r.vehicleno,
    current_dpd: r.current_dpd,
    emi_amount: r.emi_amount != null ? Number(r.emi_amount) : null,
    outstanding_amount: r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
  }));
}