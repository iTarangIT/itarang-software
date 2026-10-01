import { NextResponse } from "next/server";
import { getAuthenticatedAppUser, type AppUser } from "@/lib/kyc/admin-workflow";

/**
 * Login (and optionally role) gate for an API route handler — tracker ID 118.
 *
 * Middleware does not protect /api/* on its own: every handler has to check
 * who is calling. `requireRole` (auth-utils) does that for handlers wrapped in
 * `withErrorHandler`; this is the same check for a PLAIN handler, where
 * `requireRole` is awkward for two reasons:
 *
 *   - with no session it `redirect("/login")`s by throwing, and a handler's own
 *     try/catch swallows that throw and answers 500 "Server error";
 *   - a wrong role throws too, with the same result.
 *
 * So this one RETURNS the response instead of throwing:
 *
 *     const gate = await guardApi([...LEADS_PAGE_ROLES]);
 *     if (!gate.ok) return gate.response;
 *
 * No role list = "any signed-in user". 401 for no session, 403 for the wrong
 * role — JSON, never a redirect, because the caller is a fetch().
 */
export type ApiGuardResult =
  | { ok: true; user: AppUser }
  | { ok: false; response: NextResponse };

export async function guardApi(roles?: readonly string[]): Promise<ApiGuardResult> {
  const user = await getAuthenticatedAppUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 },
      ),
    };
  }
  if (roles && !roles.includes(user.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Forbidden: Insufficient permissions" } },
        { status: 403 },
      ),
    };
  }
  return { ok: true, user };
}
