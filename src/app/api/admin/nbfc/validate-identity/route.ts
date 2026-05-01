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
 * Pure validation endpoint for the NBFC master details form (BRD §6.0.3).
 * Accepts any subset of identity fields and returns per-field error
 * messages. Admin-only — mirrors the requireAdmin idiom used by
 * src/app/api/admin/kyc-reviews/route.ts.
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

const RequestSchema = z.object({
  rbiRegistrationNo: z.string().optional(),
  gstNumber: z.string().optional(),
  panNumber: z.string().optional(),
  primaryContactPhone: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const admin = await requireAdmin(supabase);
    if (!admin) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 },
      );
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
