import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";

// Roles treated as admin for the AI expense tracker. `sales_head` acts as the
// admin/ops role in this deployment, so it is included alongside `admin`.
// ID 166 (18 Oct check): Finance and the CEO — who may open every bill — now
// reach the tracker too. Who sees which bill link is still the bill rule
// (src/lib/expenses/billAccess.ts): the Sales Head only on their own expenses.
export const EXPENSE_ADMIN_ROLES = ["admin", "sales_head", "ceo", "finance_controller"] as const;
const EXPENSE_ADMIN_ROLE_SET = new Set<string>(EXPENSE_ADMIN_ROLES);

// ID 166 item 1 (Kartik, 23 Oct): EXPENSE_ADMIN_ROLES above is who may READ.
// Writing is split from it:
//   - admin, sales_head  → "write": everything, as before.
//   - finance_controller → "finance": reads, plus exactly three writes —
//       doc_kind on a Drive folder, clearing needs_attention on an expense,
//       clearing needs_attention on a sales invoice. Nothing else.
//   - ceo                → "read": views only; every write is 403.
export const EXPENSE_WRITE_ROLES = ["admin", "sales_head"] as const;
const EXPENSE_WRITE_ROLE_SET = new Set<string>(EXPENSE_WRITE_ROLES);
export type ExpenseAccess = "write" | "finance" | "read";

/** What this role may do on the expense tracker; null = not let in at all. */
export function expenseAccessFor(role: string | null | undefined): ExpenseAccess | null {
  const r = (role || "").toLowerCase();
  if (EXPENSE_WRITE_ROLE_SET.has(r)) return "write";
  if (r === "finance_controller") return "finance";
  if (EXPENSE_ADMIN_ROLE_SET.has(r)) return "read";
  return null;
}

export function expenseWriteForbidden(message = "FORBIDDEN: view only") {
  return NextResponse.json({ success: false, error: { message } }, { status: 403 });
}

/**
 * Gate for the expense tracker's write routes when Finance has a narrow
 * write there: returns the user and their access level ("write" or
 * "finance"); the CEO (read only) and everyone else get 403. The route
 * itself must then refuse any field Finance may not touch.
 */
export async function requireApiExpenseWriteOrFinance(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>>; access: "write" | "finance" }
  | { ok: false; response: NextResponse }
> {
  const guard = await requireApiAdmin();
  if (!guard.ok) return guard;
  const access = expenseAccessFor(guard.user.role);
  if (access !== "write" && access !== "finance") return { ok: false, response: expenseWriteForbidden() };
  return { ok: true, user: guard.user, access };
}

/** Gate for the expense tracker's write routes: Admin and Sales Head only. */
export async function requireApiExpenseWriter(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireAuth>> }
  | { ok: false; response: NextResponse }
> {
  const guard = await requireApiAdmin();
  if (!guard.ok) return guard;
  if (expenseAccessFor(guard.user.role) !== "write") return { ok: false, response: expenseWriteForbidden() };
  return guard;
}

/**
 * Read gate for the AI expense tracker API routes (every role in
 * EXPENSE_ADMIN_ROLES). Write routes use requireApiExpenseWriter /
 * requireApiExpenseWriteOrFinance instead.
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
