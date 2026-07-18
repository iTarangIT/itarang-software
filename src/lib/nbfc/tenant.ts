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
import { cache } from "react";
import { db } from "@/lib/db";
import { eq, and, count } from "drizzle-orm";
import { nbfcLoans, nbfcTenants, nbfcUsers, users } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { normalizeNbfcRole } from "@/lib/nbfc/origination-roles";

export interface TenantContext {
  id: string;
  slug: string;
  display_name: string;
  contact_email: string | null;
  aum_inr: string | null;
  active_loans: number;
  /** How we resolved this tenant — for diagnostics/logging. */
  via: "session" | "admin_query_param" | "dev_env" | "first_active" | "cron";
}

export interface SessionUser {
  id: string;
  email: string | null;
  role: string; // 'nbfc_partner' | 'admin' | 'ceo' | …
}

/**
 * Look up the current Supabase user + their CRM users.role. Returns null if
 * not authenticated.
 *
 * Wrapped in React `cache()` so it runs at most ONCE per server request. Auth
 * resolution (`resolveActor`) used to call this three times per request — via
 * getCurrentTenant, requireNbfcAccess, and directly — each spinning up its own
 * Supabase client and calling auth.getUser(). When the access token needed a
 * refresh, those repeated calls raced on Supabase's refresh-token rotation:
 * the first refresh rotated the token, the later calls used the now-revoked one
 * and returned null → an inconsistent "UNAUTHORIZED: no session" (e.g. the GET
 * succeeded but the POST that followed failed). Deduping to a single getUser()
 * per request removes the race and the extra round-trips.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<SessionUser | null> {
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
});

/**
 * Resolve the tenant the current request is for. See doc-block at top.
 */
/**
 * The live count of the tenant's active loans.
 *
 * `nbfc_tenants.active_loans` is a denormalized counter that NOTHING in the
 * application maintains — it is written once by the seed/import scripts and then
 * drifts forever. On iTarang Finance it said 14 while `nbfc_loans` held 7, so the
 * sidebar advertised twice the book the portfolio and risk pages could actually
 * see, and the risk agent was told it was reasoning about 14 loans.
 *
 * Counting the rows is cheap and cannot be wrong. Prefer this over the column.
 */
async function countActiveLoans(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, tenantId), eq(nbfcLoans.is_active, true)));
  return row?.n ?? 0;
}

/** Replace the stale stored counter with the real one before anyone reads it. */
async function withLiveLoanCount<T extends { id: string; active_loans: number }>(t: T): Promise<T> {
  return { ...t, active_loans: await countActiveLoans(t.id) };
}

export async function getCurrentTenant(opts?: { tenantSlugOverride?: string }): Promise<TenantContext> {
  const session = await getSessionUser();

  // 1. Authenticated NBFC partner → their first nbfc_users membership
  if (session && session.role === "nbfc_partner") {
    const rows = await db
      .select({
        id: nbfcTenants.id,
        slug: nbfcTenants.slug,
        display_name: nbfcTenants.display_name,
        contact_email: nbfcTenants.contact_email,
        aum_inr: nbfcTenants.aum_inr,
        active_loans: nbfcTenants.active_loans,
      })
      .from(nbfcUsers)
      .innerJoin(nbfcTenants, eq(nbfcUsers.tenant_id, nbfcTenants.id))
      .where(and(eq(nbfcUsers.user_id, session.id), eq(nbfcTenants.is_active, true)))
      .limit(1);

    if (!rows[0]) {
      throw new Error(
        `User ${session.email} is role=nbfc_partner but has no nbfc_users membership. Run scripts/invite-nbfc-user.ts to assign a tenant.`,
      );
    }
    return withLiveLoanCount({ ...rows[0], via: "session" as const });
  }

  // 2. admin/ceo with explicit ?tenant=<slug> override
  if (
    session &&
    (session.role === "admin" || session.role === "ceo") &&
    opts?.tenantSlugOverride
  ) {
    const t = await tenantBySlug(opts.tenantSlugOverride);
    if (t) return withLiveLoanCount({ ...t, via: "admin_query_param" as const });
  }

  // 3. Dev fallback via env (used until you onboard a real partner)
  const slug = process.env.NBFC_DEMO_TENANT_SLUG;
  if (slug) {
    const t = await tenantBySlug(slug);
    if (t) return withLiveLoanCount({ ...t, via: "dev_env" as const });
  }

  // 4. First active tenant — last-resort safety net for dev
  const rows = await db
    .select()
    .from(nbfcTenants)
    .where(eq(nbfcTenants.is_active, true))
    .limit(1);
  if (rows[0]) {
    return withLiveLoanCount({
      id: rows[0].id,
      slug: rows[0].slug,
      display_name: rows[0].display_name,
      contact_email: rows[0].contact_email,
      aum_inr: rows[0].aum_inr,
      active_loans: rows[0].active_loans,
      via: "first_active" as const,
    });
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
      display_name: nbfcTenants.display_name,
      contact_email: nbfcTenants.contact_email,
      aum_inr: nbfcTenants.aum_inr,
      active_loans: nbfcTenants.active_loans,
    })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, slug), eq(nbfcTenants.is_active, true)))
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
    .select({ id: nbfcUsers.tenant_id })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, session.id), eq(nbfcUsers.tenant_id, tenantId)))
    .limit(1);
  if (!rows[0]) throw new Error(`FORBIDDEN: user ${session.email} is not a member of tenant ${tenantId}`);
  return session;
}

/**
 * Resolve the current session's NBFC role within a tenant.
 *
 * Returns the normalised `nbfc_users.role` for the logged-in user in `tenantId`,
 * or null if they have no membership. Internal admin/ceo sessions (which have no
 * nbfc_users row) are reported as their CRM role so callers can grant support
 * access. Used by dashboard layouts to gate role-specific surfaces (e.g. the
 * Risk Head dashboard) — the distinction Risk Manager vs Risk Head lives only in
 * nbfc_users.role, never in the CRM users.role.
 */
export async function getCurrentNbfcRole(
  tenantId: string,
): Promise<string | null> {
  const session = await getSessionUser();
  if (!session) return null;
  if (session.role === "admin" || session.role === "ceo") return session.role;
  const rows = await db
    .select({ role: nbfcUsers.role })
    .from(nbfcUsers)
    .where(
      and(eq(nbfcUsers.user_id, session.id), eq(nbfcUsers.tenant_id, tenantId)),
    )
    .limit(1);
  if (!rows[0]) return null;
  return normalizeNbfcRole(rows[0].role);
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