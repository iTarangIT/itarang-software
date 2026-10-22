import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";

// Roles treated as admin for the AI expense tracker. `sales_head` acts as the
// admin/ops role in this deployment, so it is included alongside `admin`.
// ID 166 (18 Oct check): Finance and the CEO — who may open every bill — now
// reach the tracker too. Who sees which bill link is still the bill rule
// (src/lib/expenses/billAccess.ts): the Sales Head only on their own expenses.
export const EXPENSE_ADMIN_ROLES = ["admin", "sales_head", "ceo", "finance_controller"] as const;
const EXPENSE_ADMIN_ROLE_SET = new Set<string>(EXPENSE_ADMIN_ROLES);

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
  if (!EXPENSE_ADMIN_ROLE_SET.has((user.role || "").toLowerCase())) {
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
