/**
 * E-111 — GET /api/admin/nbfc/{nbfcId}/corrections/latest
 *
 * Returns the latest correction round for an NBFC (any status), with its
 * items expanded and human-readable labels resolved from the catalog.
 * Used by both:
 *   - CEO review page (to show "Resolved" badges on previously-flagged items)
 *   - Admin approval/edit pages (to show the outstanding-corrections panel
 *     and inline flagged-item badges)
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  type CorrectionKind,
  labelFor,
  sectionFor,
} from "@/lib/nbfc/admin/correction-catalog";

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

  const [round] = await db
    .select()
    .from(nbfcCorrectionRounds)
    .where(eq(nbfcCorrectionRounds.nbfc_id, id))
    .orderBy(desc(nbfcCorrectionRounds.round_number))
    .limit(1);

  if (!round) {
    return NextResponse.json({ ok: true, round: null });
  }

  const items = await db
    .select()
    .from(nbfcCorrectionItems)
    .where(eq(nbfcCorrectionItems.round_id, round.id))
    .orderBy(nbfcCorrectionItems.id);

  const expandedItems = items.map((it) => {
    const kind = it.kind as CorrectionKind;
    return {
      id: it.id,
      kind,
      targetKey: it.target_key,
      targetRefId: it.target_ref_id,
      label: labelFor(kind, it.target_key),
      section: sectionFor(kind),
      previousValue: it.previous_value,
      previousFileUrl: it.previous_file_url,
      remark: it.remark,
      resolutionStatus: it.resolution_status,
      newValue: it.new_value,
      newFileUrl: it.new_file_url,
      resolvedAt: it.resolved_at,
      resolvedBy: it.resolved_by,
      createdAt: it.created_at,
    };
  });

  const pendingCount = expandedItems.filter(
    (i) => i.resolutionStatus === "pending",
  ).length;

  return NextResponse.json({
    ok: true,
    round: {
      id: round.id,
      nbfcId: round.nbfc_id,
      roundNumber: round.round_number,
      status: round.status,
      requestedBy: round.requested_by,
      summaryRemarks: round.summary_remarks,
      resolvedAt: round.resolved_at,
      resolvedBy: round.resolved_by,
      createdAt: round.created_at,
      updatedAt: round.updated_at,
      items: expandedItems,
      pendingCount,
      totalCount: expandedItems.length,
    },
  });
}
