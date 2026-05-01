/**
 * Dual-approval auth + actor resolution.
 *
 * In production this delegates to `getCurrentTenant()` + `requireNbfcAccess()`
 * to derive the tenant and the calling user from the Supabase session, then
 * looks up the user's NBFC role from `nbfc_users`.
 *
 * In non-production environments, when both:
 *   1. process.env.NBFC_TEST_BYPASS_SECRET is set, AND
 *   2. The request carries an `x-nbfc-test-bypass` header equal to that secret,
 *
 * we accept the additional headers `x-nbfc-test-tenant-id`, `x-nbfc-test-user-id`,
 * and `x-nbfc-test-user-role` to fabricate an actor. This bypass exists for the
 * NBFC self-coding loop's Playwright API tests — it is gated three ways
 * (env != production, server secret, matching request header) so it cannot
 * be abused by a leaked header alone.
 */
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { nbfcUsers, nbfcTenants } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess, getSessionUser } from "@/lib/nbfc/tenant";

export interface DualApprovalActor {
  user_id: string;
  tenant_id: string;
  tenant_slug: string;
  role: string;
  via: "session" | "test_bypass";
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Returns true iff (a) we're not in production, (b) NBFC_TEST_BYPASS_SECRET
 * is set, and (c) the request header `x-nbfc-test-bypass` matches it.
 */
export function isTestBypassRequest(headers: Headers): boolean {
  if (isProd()) return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get("x-nbfc-test-bypass");
  return !!provided && provided === secret;
}

export async function resolveActor(headers: Headers): Promise<DualApprovalActor> {
  if (isTestBypassRequest(headers)) {
    const tenantId = headers.get("x-nbfc-test-tenant-id");
    const userId = headers.get("x-nbfc-test-user-id");
    const role = headers.get("x-nbfc-test-user-role") ?? "viewer";
    if (!tenantId || !userId) {
      throw new Error("UNAUTHORIZED: test bypass missing tenant/user headers");
    }
    const rows = await db
      .select({ id: nbfcTenants.id, slug: nbfcTenants.slug })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, tenantId))
      .limit(1);
    if (rows.length === 0) {
      throw new Error("FORBIDDEN: tenant not found for test bypass");
    }
    return {
      user_id: userId,
      tenant_id: rows[0].id,
      tenant_slug: rows[0].slug,
      role,
      via: "test_bypass",
    };
  }

  // Production path: use the canonical tenant + access primitives.
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);
  const session = await getSessionUser();
  if (!session) {
    throw new Error("UNAUTHORIZED: no session user");
  }
  // Look up the NBFC role for (user, tenant)
  const rows = await db
    .select({ role: nbfcUsers.role })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, session.id), eq(nbfcUsers.tenant_id, tenant.id)))
    .limit(1);
  const role = rows[0]?.role ?? "viewer";
  return {
    user_id: session.id,
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    role,
    via: "session",
  };
}
