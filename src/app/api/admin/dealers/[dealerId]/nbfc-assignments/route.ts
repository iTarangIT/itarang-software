// [E-012] /api/admin/dealers/{dealerId}/nbfc-assignments  (POST + GET)
//
// BRD §6.0.8 — junction table dealer_nbfc_assignments (Sync Audit G-05).
// Links finance-enabled dealers to their approved NBFCs. Only NBFCs in this
// table appear in a given dealer's loan-sanction dropdown (consumed by E-013).
//
// Rules:
//   - Linking allowed only when nbfc.status IN ('approved','active') -> 422.
//   - UNIQUE (dealer_id, nbfc_id) enforced at the DB level -> 409 on duplicate.
//   - Dealer / NBFC missing -> 404.
//   - Auth: admin (requireAdminOrTestBypass for the loop test plumbing).
//
// dealerId path param is dual-keyed (mirrors E-102): pure-numeric => INT PK,
// anything else => VARCHAR dealer_id.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealers,
  dealerNbfcAssignments,
  nbfc,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

const NBFC_LINK_ELIGIBLE_STATUSES = new Set(["approved", "active"]);

const postBodySchema = z.object({
  nbfcId: z.number().int().positive(),
  notes: z.string().max(2000).optional(),
});

const getQuerySchema = z.object({
  status: z.enum(["active", "suspended", "terminated"]).optional(),
});

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

async function resolveDealer(dealerIdParam: string) {
  const [row] = isNumericId(dealerIdParam)
    ? await db
        .select()
        .from(dealers)
        .where(eq(dealers.id, Number(dealerIdParam)))
        .limit(1)
    : await db
        .select()
        .from(dealers)
        .where(eq(dealers.dealer_id, dealerIdParam))
        .limit(1);
  return row ?? null;
}

// resolve admin user_id surrogate to an INT for enabled_by. The auth helper
// returns a UUID-string for the supabase user; our column is INTEGER per BRD,
// so we hash to a positive int. In the test bypass path we accept an explicit
// header so tests can assert the persisted value deterministically.
function adminEnabledBy(req: NextRequest, fallbackUserId: string): number {
  const headerVal = req.headers.get("x-nbfc-test-enabled-by");
  if (headerVal) {
    const n = Number.parseInt(headerVal, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Deterministic, stable, non-negative 31-bit hash of the user id.
  let h = 0;
  for (let i = 0; i < fallbackUserId.length; i++) {
    h = (h * 31 + fallbackUserId.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// POST — create assignment
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  try {
    const { dealerId: dealerIdParam } = await context.params;
    if (!dealerIdParam) {
      return NextResponse.json(
        { success: false, message: "Missing dealerId path parameter" },
        { status: 400 },
      );
    }

    const json = await req.json().catch(() => null);
    const parsed = postBodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "VALIDATION_ERROR",
          message: "Invalid request body",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    // Resolve dealer (404)
    const dealerRow = await resolveDealer(dealerIdParam);
    if (!dealerRow) {
      return NextResponse.json(
        { success: false, error: "DEALER_NOT_FOUND", message: "Dealer not found" },
        { status: 404 },
      );
    }

    // Resolve nbfc (404)
    const [nbfcRow] = await db
      .select()
      .from(nbfc)
      .where(eq(nbfc.id, parsed.data.nbfcId))
      .limit(1);
    if (!nbfcRow) {
      return NextResponse.json(
        { success: false, error: "NBFC_NOT_FOUND", message: "NBFC not found" },
        { status: 404 },
      );
    }

    // Gate: nbfc must be approved/active (422)
    if (!NBFC_LINK_ELIGIBLE_STATUSES.has(nbfcRow.status)) {
      return NextResponse.json(
        {
          success: false,
          error: "nbfc_not_approved",
          message:
            "NBFC must be in 'approved' or 'active' status before assignment",
          nbfcStatus: nbfcRow.status,
        },
        { status: 422 },
      );
    }

    // Pre-check duplicate (409). We also catch unique-violation from the DB
    // as a belt-and-braces fallback against race conditions.
    const existing = await db
      .select()
      .from(dealerNbfcAssignments)
      .where(
        and(
          eq(dealerNbfcAssignments.dealer_id, dealerRow.id),
          eq(dealerNbfcAssignments.nbfc_id, nbfcRow.id),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: "already_assigned",
          message: "Dealer is already assigned to this NBFC",
          assignmentId: existing[0].id,
        },
        { status: 409 },
      );
    }

    const enabledBy = adminEnabledBy(req, auth.user.id);

    let inserted;
    try {
      [inserted] = await db
        .insert(dealerNbfcAssignments)
        .values({
          dealer_id: dealerRow.id,
          nbfc_id: nbfcRow.id,
          enabled_by: enabledBy,
          status: "active",
          notes: parsed.data.notes ?? null,
        })
        .returning();
    } catch (err: any) {
      // Postgres unique-violation -> 23505. Race-safe duplicate path.
      if (err?.code === "23505") {
        return NextResponse.json(
          {
            success: false,
            error: "already_assigned",
            message: "Dealer is already assigned to this NBFC",
          },
          { status: 409 },
        );
      }
      throw err;
    }

    return NextResponse.json(
      {
        success: true,
        id: inserted.id,
        dealerId: inserted.dealer_id,
        nbfcId: inserted.nbfc_id,
        status: inserted.status,
        enabledAt: inserted.enabled_at,
        notes: inserted.notes,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    console.error("ADMIN DEALER NBFC ASSIGNMENT POST ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to create assignment" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET — list assignments for a dealer
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  try {
    const { dealerId: dealerIdParam } = await context.params;
    if (!dealerIdParam) {
      return NextResponse.json(
        { success: false, message: "Missing dealerId path parameter" },
        { status: 400 },
      );
    }

    const url = new URL(req.url);
    const parsedQuery = getQuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          success: false,
          error: "VALIDATION_ERROR",
          message: "Invalid query parameters",
          issues: parsedQuery.error.flatten(),
        },
        { status: 400 },
      );
    }

    const dealerRow = await resolveDealer(dealerIdParam);
    if (!dealerRow) {
      return NextResponse.json(
        { success: false, error: "DEALER_NOT_FOUND", message: "Dealer not found" },
        { status: 404 },
      );
    }

    const conditions = [eq(dealerNbfcAssignments.dealer_id, dealerRow.id)];
    if (parsedQuery.data.status) {
      conditions.push(eq(dealerNbfcAssignments.status, parsedQuery.data.status));
    }

    const rows = await db
      .select({
        id: dealerNbfcAssignments.id,
        nbfcId: dealerNbfcAssignments.nbfc_id,
        shortName: nbfc.short_name,
        status: dealerNbfcAssignments.status,
        enabledAt: dealerNbfcAssignments.enabled_at,
        notes: dealerNbfcAssignments.notes,
      })
      .from(dealerNbfcAssignments)
      .innerJoin(nbfc, eq(dealerNbfcAssignments.nbfc_id, nbfc.id))
      .where(and(...conditions));

    return NextResponse.json({ success: true, items: rows });
  } catch (error: unknown) {
    console.error("ADMIN DEALER NBFC ASSIGNMENT GET ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch assignments" },
      { status: 500 },
    );
  }
}
