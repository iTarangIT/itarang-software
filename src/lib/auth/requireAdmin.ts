import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Middleware treats /api/* as public (src/middleware.ts), so each admin API
// handler must gate itself. Use this helper at the top of every route under
// /api/admin/dealer-verifications/[dealerId]/** so the approve/reject/PATCH
// flows can't be invoked by an unauthenticated caller.

const ADMIN_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
]);

type AdminUser = {
  id: string;
  email: string | null;
  role: string;
};

export type RequireAdminResult =
  | { ok: true; user: AdminUser }
  | { ok: false; response: NextResponse };

/**
 * Ensure the caller has an active session and one of the admin-capable roles.
 * Returns either the authenticated user or a ready-to-return NextResponse with
 * the appropriate 401/403 status.
 */
export async function requireAdmin(): Promise<RequireAdminResult> {
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
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row || !ADMIN_ROLES.has(row.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user: row };
}
