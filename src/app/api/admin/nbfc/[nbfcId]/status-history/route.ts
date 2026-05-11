/**
 * E-011 — GET /api/admin/nbfc/{nbfcId}/status-history
 *
 * Returns the append-only audit trail of NBFC status transitions in
 * chronological order (oldest first).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcStatusHistory } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const [exists] = await db
    .select({ id: nbfc.id })
    .from(nbfc)
    .where(eq(nbfc.id, id));
  if (!exists) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  const rows = await db
    .select({
      fromStatus: nbfcStatusHistory.from_status,
      toStatus: nbfcStatusHistory.to_status,
      actorId: nbfcStatusHistory.actor_id,
      reason: nbfcStatusHistory.reason,
      occurredAt: nbfcStatusHistory.occurred_at,
    })
    .from(nbfcStatusHistory)
    .where(eq(nbfcStatusHistory.nbfc_id, id))
    .orderBy(asc(nbfcStatusHistory.occurred_at));

  return NextResponse.json({ ok: true, items: rows });
}
