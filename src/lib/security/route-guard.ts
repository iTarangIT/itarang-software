/**
 * Guard for the security-dashboard API routes. Middleware treats /api/* as
 * public (src/middleware.ts), so each handler must gate itself. Same shape as
 * requireSalesHead (id-then-email lookup, is_active check).
 *
 * The security surface lives in the IT Dashboard (/it) and nowhere else — the
 * `it` role is the ONLY role admitted here. Admin and CEO were removed
 * deliberately when the dashboard was split out; re-adding them would put
 * vulnerability detail (live exploit reproductions, unauthenticated PII
 * endpoints) back in front of every business login.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const SECURITY_ADMIN_ROLES = new Set(["it"]);

type GuardUser = { id: string; email: string | null; role: string };

export type SecurityGuardResult =
  | { ok: true; user: GuardUser }
  | { ok: false; response: NextResponse };

export async function requireSecurityAdmin(): Promise<SecurityGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }

  const cols = { id: users.id, email: users.email, role: users.role, is_active: users.is_active };
  let [row] = await db.select(cols).from(users).where(eq(users.id, user.id)).limit(1);
  if (!row && user.email) {
    [row] = await db.select(cols).from(users).where(eq(users.email, user.email)).limit(1);
  }

  if (!row || !row.is_active || !SECURITY_ADMIN_ROLES.has(row.role)) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  }

  return { ok: true, user: { id: row.id, email: row.email, role: row.role } };
}
