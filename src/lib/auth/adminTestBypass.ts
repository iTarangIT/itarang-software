/**
 * Triple-guarded admin auth bypass for the NBFC self-coding loop.
 *
 * Production /api/admin/** routes call requireAdmin() which round-trips through
 * Supabase Auth. Loop tests can't carry a Supabase cookie, so this helper lets
 * them fabricate an admin actor when ALL three gates are open:
 *
 *   1. NODE_ENV !== 'production'
 *   2. Server has NBFC_TEST_BYPASS_SECRET set in env
 *   3. Request carries header  x-nbfc-test-bypass = <that secret>
 *
 * If accepted, the caller may also send:
 *   x-nbfc-test-user-id    UUID of the synthetic admin (required)
 *   x-nbfc-test-user-role  one of admin/ceo/business_head/sales_head (default: admin)
 *
 * Mirrors the dual-approval bypass but for admin-role-gated routes.
 */
import { NextResponse } from "next/server";
import { requireAdmin, type RequireAdminResult } from "./requireAdmin";

const ADMIN_BYPASS_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
]);

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function isTestBypassRequest(headers: Headers): boolean {
  if (isProd()) return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get("x-nbfc-test-bypass");
  return !!provided && provided === secret;
}

export async function requireAdminOrTestBypass(
  headers: Headers,
): Promise<RequireAdminResult> {
  if (isTestBypassRequest(headers)) {
    const userId = headers.get("x-nbfc-test-user-id");
    const role = headers.get("x-nbfc-test-user-role") ?? "admin";
    if (!userId) {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, message: "Unauthorized" },
          { status: 401 },
        ),
      };
    }
    if (!ADMIN_BYPASS_ROLES.has(role)) {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, message: "Forbidden" },
          { status: 403 },
        ),
      };
    }
    return {
      ok: true,
      user: { id: userId, email: null, role, via: "test_bypass" },
    };
  }
  return requireAdmin();
}
