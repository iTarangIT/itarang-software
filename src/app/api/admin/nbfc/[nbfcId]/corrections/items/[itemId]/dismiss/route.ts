/**
 * E-111 — POST /api/admin/nbfc/{nbfcId}/corrections/items/{itemId}/dismiss
 *
 * Admin marks a single flagged item as dismissed (no fix applied) with a
 * reason. Used when admin disagrees with the CEO's flag but wants to
 * unblock resubmission. The item moves to `dismissed`; the round is
 * unaffected (auto-resolve on resubmit will not re-touch dismissed items).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  reason: z.string().min(1).max(2000),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string; itemId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId, itemId } = await ctx.params;
  const idN = Number.parseInt(nbfcId, 10);
  const itemN = Number.parseInt(itemId, 10);
  if (
    !Number.isInteger(idN) ||
    idN <= 0 ||
    !Number.isInteger(itemN) ||
    itemN <= 0
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid id(s)" },
      { status: 400 },
    );
  }

  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Verify the item belongs to a round on this NBFC.
  const rows = await db
    .select({
      itemId: nbfcCorrectionItems.id,
      resolutionStatus: nbfcCorrectionItems.resolution_status,
      roundId: nbfcCorrectionRounds.id,
      roundStatus: nbfcCorrectionRounds.status,
    })
    .from(nbfcCorrectionItems)
    .innerJoin(
      nbfcCorrectionRounds,
      eq(nbfcCorrectionItems.round_id, nbfcCorrectionRounds.id),
    )
    .where(
      and(
        eq(nbfcCorrectionItems.id, itemN),
        eq(nbfcCorrectionRounds.nbfc_id, idN),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "NOT_FOUND" },
      { status: 404 },
    );
  }
  if (row.resolutionStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: "CONFLICT",
        message: `Item is already ${row.resolutionStatus}`,
      },
      { status: 409 },
    );
  }

  const now = new Date();
  await db
    .update(nbfcCorrectionItems)
    .set({
      resolution_status: "dismissed",
      new_value: parsed.data.reason,
      resolved_at: now,
      resolved_by: auth.user.id,
    })
    .where(eq(nbfcCorrectionItems.id, itemN));

  return NextResponse.json({
    ok: true,
    itemId: itemN,
    resolutionStatus: "dismissed",
    resolvedAt: now,
  });
}
