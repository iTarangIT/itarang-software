import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth-utils";

/**
 * Access control for the Fleet Monitor (/monitor and /api/monitor/*).
 *
 * Modelled on src/lib/operations/route-guard.ts, which is the reference
 * implementation for a single-login monitoring role in this codebase.
 *
 * Deliberately a set of ONE. The point of monitor@itarang.com is that it can be
 * handed to whoever is watching the fleet without also handing over leads, KYC
 * or finance — a role that inherited any of those would defeat the reason it
 * exists.
 *
 * Note middleware.ts lets `ceo` into every dashboard path (the bounce at the end
 * of middleware() exempts it), so a CEO session WILL reach these pages.
 * requireMonitorPage() therefore redirects it to /ceo rather than throwing — the
 * CEO already has this data, in more depth, at /ceo/intellicar. Widen
 * MONITOR_ROLES if that call is ever revisited; do not special-case it at
 * individual call sites.
 */
export const MONITOR_ROLES = new Set(["monitor"]);

function normalise(role: string | null | undefined) {
  return (role || "").trim().toLowerCase();
}

/**
 * API gate. First two lines of every /api/monitor/* handler:
 *
 *   const auth = await requireMonitorAdmin();
 *   if (!auth.ok) return auth.response;
 *
 * Returns the authed user on success, or the NextResponse to return.
 *
 * requireAuth() does the id-then-email user lookup that this codebase depends
 * on (Supabase lowercases emails while users.email is mixed-case, so an
 * email-only lookup is the classic "no session / wrong user" bug here) and
 * redirects to /login when there is no Supabase session at all.
 */
export async function requireMonitorAdmin(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>> }
  | { ok: false; response: NextResponse }
> {
  const user = await requireAuth();

  const forbidden = {
    ok: false as const,
    response: NextResponse.json(
      { success: false, error: { message: "FORBIDDEN: monitor role required" } },
      { status: 403 },
    ),
  };

  if (!MONITOR_ROLES.has(normalise(user.role))) return forbidden;

  // requireAuth() synthesises a { role: "user" } object when the Supabase user
  // has no `users` row, so a real row is implied by the role check above — but
  // a deactivated account must still be refused. `is_active` is not on the
  // synthesised shape, hence the cast.
  const isActive = (user as { is_active?: boolean | null }).is_active;
  if (isActive === false) return forbidden;

  return { ok: true, user };
}

/**
 * Page gate for server components under (dashboard)/monitor/.
 *
 *   const user = await requireMonitorPage();
 *
 * Lives in monitor/layout.tsx rather than in the page, so a second page added
 * under /monitor later cannot ship unguarded.
 *
 * Redirects rather than throwing: a wrong-role user who followed a stale link
 * should land somewhere useful, not on an error page.
 */
export async function requireMonitorPage() {
  const user = await requireAuth();
  const role = normalise(user.role);

  if (MONITOR_ROLES.has(role)) {
    if ((user as { is_active?: boolean | null }).is_active === false) {
      redirect("/login");
    }
    return user;
  }

  // See the note above — middleware lets ceo through, so send it to the fuller
  // version of this data rather than showing it a wall.
  if (role === "ceo") redirect("/ceo");

  redirect("/");
}
