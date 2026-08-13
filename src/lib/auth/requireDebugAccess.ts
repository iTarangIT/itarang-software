import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Shared gate for the developer-diagnostic endpoints: /api/debug/* and
// /api/test-*. Middleware treats /api/* as public (src/middleware.ts), so each
// of them was reachable by anyone who knew the path — the security scanner's
// debugEndpointProbe flags exactly this (DEBUG_ROUTES in src/lib/security/crawl.ts),
// and SECURITY_REVIEW.md called for them to be "removed or env-gated".
//
// Two rules, both deliberate:
//
//   1. In production these endpoints DO NOT EXIST. A diagnostic that dumps
//      information_schema, proves DB reachability, sends live email or writes
//      to the shared Google Sheet has no business being callable in prod, not
//      even by an admin.
//   2. Outside production they still require an admin/IT session. Sandbox is
//      internet-facing, so "not production" is not the same as "safe".
//
// Every rejection is a 404, never a 401/403: a debug route should not confirm
// its own existence to an unauthenticated caller. That also satisfies the
// probe, which treats anything other than 404/401/403/redirect as exposure.

const DEBUG_ROLES = new Set(["admin", "it", "ceo"]);

/** Returned when access is denied — callers `return` it as-is. */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export type DebugAccessResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

export async function requireDebugAccess(): Promise<DebugAccessResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, response: notFound() };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { ok: false, response: notFound() };

    // Mirrors requireAdmin's id-then-email lookup: some legacy rows have
    // public.users.id != auth.users.id.
    let [row] = await db
      .select({ role: users.role, is_active: users.is_active })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (!row && user.email) {
      [row] = await db
        .select({ role: users.role, is_active: users.is_active })
        .from(users)
        .where(eq(users.email, user.email))
        .limit(1);
    }

    if (!row || !row.is_active || !DEBUG_ROLES.has(row.role)) {
      return { ok: false, response: notFound() };
    }

    return { ok: true };
  } catch {
    // Fail closed — a lookup error must not open the endpoint.
    return { ok: false, response: notFound() };
  }
}
