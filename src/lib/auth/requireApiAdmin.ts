import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";

// Roles treated as admin for the AI expense tracker. `sales_head` acts as the
// admin/ops role in this deployment, so it is included alongside `admin`.
const EXPENSE_ADMIN_ROLES = new Set(["admin", "sales_head"]);

/**
 * Admin gate for the AI expense tracker API routes.
 *
 * Returns the authed user on success, or a 401/403 NextResponse to return.
 */
export async function requireApiAdmin(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>> }
  | { ok: false; response: NextResponse }
> {
  const user = await requireAuth();
  if (!EXPENSE_ADMIN_ROLES.has((user.role || "").toLowerCase())) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: admin only" } },
        { status: 403 },
      ),
    };
  }
  return { ok: true, user };
}
