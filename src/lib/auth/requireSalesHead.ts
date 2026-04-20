import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Middleware treats /api/* as public (src/middleware.ts), so each API handler
// must gate itself. Use this helper at the top of every route under
// /api/admin/dealer-verifications/** so approve/reject/PATCH/agreement flows
// are restricted to sales_head only (product decision — dealer onboarding
// review is owned solely by sales_head, not the broader admin-capable set).

const SALES_HEAD_ROLES = new Set(["sales_head"]);

type SalesHeadUser = {
  id: string;
  email: string | null;
  role: string;
};

export type RequireSalesHeadResult =
  | { ok: true; user: SalesHeadUser }
  | { ok: false; response: NextResponse };

/**
 * Ensure the caller has an active session and the sales_head role.
 * Returns either the authenticated user or a ready-to-return NextResponse with
 * the appropriate 401/403 status.
 */
export async function requireSalesHead(): Promise<RequireSalesHeadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      ),
    };
  }

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      is_active: users.is_active,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  // Reject deactivated users — is_active can be flipped to revoke access
  // without also stripping the role.
  if (!row || !row.is_active || !SALES_HEAD_ROLES.has(row.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user: { id: row.id, email: row.email, role: row.role } };
}
