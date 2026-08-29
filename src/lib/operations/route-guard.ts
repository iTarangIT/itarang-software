import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth-utils";

/**
 * Access control for the Ops Console (/operations and /api/operations/*).
 *
 * Deliberately a set of ONE. The console surfaces company-wide spend,
 * infrastructure detail and connection strings' worth of context about the
 * estate; it is a monitoring login for the tech team, not a role anyone
 * inherits by seniority.
 *
 * Note middleware.ts still lets `ceo` into every dashboard path (the bounce at
 * the end of middleware() exempts it), so a CEO session WILL reach these pages.
 * requireOperationsPage() therefore redirects it to /ceo rather than throwing —
 * a 403 for the one role middleware deliberately waves through reads as a bug,
 * not as policy. Widen OPERATIONS_ROLES if that call is ever revisited; do not
 * special-case it at individual call sites.
 *
 * The role string "operations" also exists on `nbfc_users.role` (see
 * src/lib/nbfc/origination-roles.ts). That one is resolved by
 * resolveActor(headers) against an NBFC tenant and is never compared against
 * `users.role`. These guards read `users.role` only.
 */
export const OPERATIONS_ROLES = new Set(["operations"]);

function normalise(role: string | null | undefined) {
  return (role || "").trim().toLowerCase();
}

/**
 * API gate. First two lines of every /api/operations/* handler:
 *
 *   const auth = await requireOperationsAdmin();
 *   if (!auth.ok) return auth.response;
 *
 * Returns the authed user on success, or the NextResponse to return.
 *
 * requireAuth() does the id-then-email user lookup that this codebase depends
 * on (Supabase lowercases emails while users.email is mixed-case, so an
 * email-only lookup is the classic "no session / wrong user" bug here) and
 * redirects to /login when there is no Supabase session at all.
 */
export async function requireOperationsAdmin(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>> }
  | { ok: false; response: NextResponse }
> {
  const user = await requireAuth();

  const forbidden = {
    ok: false as const,
    response: NextResponse.json(
      { success: false, error: { message: "FORBIDDEN: operations role required" } },
      { status: 403 },
    ),
  };

  if (!OPERATIONS_ROLES.has(normalise(user.role))) return forbidden;

  // requireAuth() synthesises a { role: "user" } object when the Supabase user
  // has no `users` row, so a real row is implied by the role check above — but
  // a deactivated account must still be refused. `is_active` is not on the
  // synthesised shape, hence the cast.
  const isActive = (user as { is_active?: boolean | null }).is_active;
  if (isActive === false) return forbidden;

  return { ok: true, user };
}

/**
 * Page gate for server components under (dashboard)/operations/.
 *
 *   const user = await requireOperationsPage();
 *
 * Redirects rather than throwing: a wrong-role user who followed a stale link
 * should land somewhere useful, not on an error page.
 */
export async function requireOperationsPage() {
  const user = await requireAuth();
  const role = normalise(user.role);

  if (OPERATIONS_ROLES.has(role)) {
    if ((user as { is_active?: boolean | null }).is_active === false) {
      redirect("/login");
    }
    return user;
  }

  // See the note above — middleware lets ceo through, so send it home rather
  // than showing it a wall.
  if (role === "ceo") redirect("/ceo");

  redirect("/");
}

/**
 * Access control for /operations/usage and /api/operations/usage.
 *
 * SAME MEMBERS AS OPERATIONS_ROLES TODAY. That is not the point — the point is
 * that they are now two sets, so widening one does not silently widen the other.
 *
 * The doc comment above literally invites the widening: "Widen OPERATIONS_ROLES
 * if that call is ever revisited." The day somebody does that for a legitimate
 * infrastructure reason — an admin who needs to see disk space, say — they would
 * otherwise also be handing over per-employee sign-in history in the same edit,
 * without noticing. This split makes that a separate, deliberate, reviewable
 * decision next to a comment explaining exactly what it grants.
 *
 * `ceo` keeps the /ceo redirect it gets from requireOperationsPage(): the usage
 * data is per-person, so the one role middleware waves through is the last one
 * that should land here by accident.
 */
export const USAGE_ANALYTICS_ROLES = new Set(["operations"]);

/**
 * API gate for the usage endpoints. Same contract as requireOperationsAdmin().
 */
export async function requireUsageAnalyticsAdmin(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>> }
  | { ok: false; response: NextResponse }
> {
  const user = await requireAuth();

  const forbidden = {
    ok: false as const,
    response: NextResponse.json(
      {
        success: false,
        error: { message: "FORBIDDEN: usage analytics access required" },
      },
      { status: 403 },
    ),
  };

  if (!USAGE_ANALYTICS_ROLES.has(normalise(user.role))) return forbidden;
  if ((user as { is_active?: boolean | null }).is_active === false) {
    return forbidden;
  }

  return { ok: true, user };
}

/**
 * Page gate for /operations/usage.
 *
 * Called INSIDE the page as well as inheriting operations/layout.tsx's gate.
 * The layout comment argues that a per-page gate is the failure mode to avoid
 * (a new module shipping unguarded), and that is right in general — this page is
 * the deliberate exception, because the layout gate is precisely the thing that
 * might get widened later. Two gates here is cheap; the failure it prevents is
 * not.
 */
export async function requireUsageAnalyticsPage() {
  const user = await requireAuth();
  const role = normalise(user.role);

  if (USAGE_ANALYTICS_ROLES.has(role)) {
    if ((user as { is_active?: boolean | null }).is_active === false) {
      redirect("/login");
    }
    return user;
  }

  if (role === "ceo") redirect("/ceo");

  redirect("/");
}
