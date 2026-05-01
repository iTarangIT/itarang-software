import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { validateIdentity } from "@/lib/nbfc/identityValidators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/nbfc/validate-identity
 *
 * Pure regex validation for the NBFC master details form (BRD §6.0.3).
 * Admin-gated — mirrors the requireAdmin idiom used by
 * src/app/api/admin/kyc-reviews/route.ts.
 *
 * Test-bypass affordance: when (a) NODE_ENV !== 'production', (b) a non-empty
 * E2E_TEST_BYPASS_SECRET is set in the server env, and (c) the request
 * carries a matching x-e2e-test-secret header, the auth check is skipped.
 * This lets the worktree-local loop exercise the validator without standing
 * up a full Supabase admin login. The triple guard (env-gated, secret-gated,
 * not-prod-gated) keeps the production deployment safe — production never
 * reads E2E_TEST_BYPASS_SECRET so the header has no effect there.
 */

const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
] as const;

async function requireAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  let dbUser =
    (
      await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
    )[0] ?? null;

  if (!dbUser && user.email) {
    dbUser =
      (
        await db
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.email, user.email))
          .limit(1)
      )[0] ?? null;
  }

  if (
    !dbUser ||
    !ADMIN_ROLES.includes(dbUser.role as (typeof ADMIN_ROLES)[number])
  ) {
    return null;
  }
  return dbUser;
}

function isAuthorisedTestBypass(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const expected = process.env.E2E_TEST_BYPASS_SECRET;
  if (!expected) return false;
  const header = req.headers.get("x-e2e-test-secret");
  return !!header && header === expected;
}

const RequestSchema = z.object({
  rbiRegistrationNo: z.string().optional(),
  gstNumber: z.string().optional(),
  panNumber: z.string().optional(),
  primaryContactPhone: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorisedTestBypass(req)) {
      const supabase = await createClient();
      const admin = await requireAdmin(supabase);
      if (!admin) {
        return NextResponse.json(
          { ok: false, error: "UNAUTHORIZED" },
          { status: 401 },
        );
      }
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "VALIDATION",
          issues: parsed.error.issues,
        },
        { status: 422 },
      );
    }

    const result = validateIdentity(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
