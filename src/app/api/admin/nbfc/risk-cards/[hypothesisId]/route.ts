import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfc, riskHypotheses, nbfcRiskCardVisibility } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// Per-CARD risk-card visibility — the inverse axis of
// /api/admin/nbfc/[nbfcId]/risk-cards.
//
// That route sets "which cards this NBFC sees". This one sets "which NBFCs see
// this card": the admin opens a single risk hypothesis and multi-selects the
// activated partners it should appear for. Both write the same
// nbfc_risk_card_visibility allowlist (presence of a (tenant_id, hypothesis_id)
// row = card visible on that partner's Risk dashboard), just along different
// axes — so they compose without conflict.
//
// The client sends INTEGER nbfc.id values; risk cards live on the uuid
// nbfc_tenants side, so we bridge via nbfc.tenant_id (set at activation). Only
// active NBFCs with a tenant are eligible; anything else is silently dropped.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putBodySchema = z.object({
  nbfc_ids: z.array(z.number().int().positive()).default([]),
});

/** Confirm the hypothesis exists and isn't retired. */
async function resolveHypothesis(
  hypothesisId: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const [row] = await db
    .select({ id: riskHypotheses.id, retired_at: riskHypotheses.retired_at })
    .from(riskHypotheses)
    .where(eq(riskHypotheses.id, hypothesisId))
    .limit(1);
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "Risk card not found" },
        { status: 404 },
      ),
    };
  }
  if (row.retired_at) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "This risk card is retired and cannot be shown." },
        { status: 409 },
      ),
    };
  }
  return { ok: true };
}

const uuidSchema = z.string().uuid();

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ hypothesisId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { hypothesisId } = await params;
  if (!uuidSchema.safeParse(hypothesisId).success) {
    return NextResponse.json(
      { success: false, message: "Invalid hypothesisId" },
      { status: 400 },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = putBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Validation failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const hyp = await resolveHypothesis(hypothesisId);
  if (!hyp.ok) return hyp.response;

  // Resolve the requested nbfc ids to their portal tenants, keeping only
  // activated NBFCs that actually have a tenant. A stale/non-activated id in the
  // request is dropped rather than minting a row that can never render.
  const requestedNbfcIds = [...new Set(parsed.data.nbfc_ids)];
  let tenantIds: string[] = [];
  if (requestedNbfcIds.length > 0) {
    const rows = await db
      .select({ tenant_id: nbfc.tenant_id })
      .from(nbfc)
      .where(
        and(
          inArray(nbfc.id, requestedNbfcIds),
          eq(nbfc.status, "active"),
          isNotNull(nbfc.tenant_id),
        ),
      );
    tenantIds = rows
      .map((r) => r.tenant_id)
      .filter((t): t is string => typeof t === "string");
  }

  await db.transaction(async (tx) => {
    if (tenantIds.length > 0) {
      // Drop this card from any tenant no longer selected.
      await tx
        .delete(nbfcRiskCardVisibility)
        .where(
          and(
            eq(nbfcRiskCardVisibility.hypothesis_id, hypothesisId),
            notInArray(nbfcRiskCardVisibility.tenant_id, tenantIds),
          ),
        );
      // Add it to the newly selected tenants; the unique
      // (tenant_id, hypothesis_id) index makes re-selecting a no-op.
      await tx
        .insert(nbfcRiskCardVisibility)
        .values(
          tenantIds.map((tenant_id) => ({
            tenant_id,
            hypothesis_id: hypothesisId,
            updated_by: auth.user.id,
          })),
        )
        .onConflictDoNothing({
          target: [
            nbfcRiskCardVisibility.tenant_id,
            nbfcRiskCardVisibility.hypothesis_id,
          ],
        });
    } else {
      // Empty selection removes this card from every tenant.
      await tx
        .delete(nbfcRiskCardVisibility)
        .where(eq(nbfcRiskCardVisibility.hypothesis_id, hypothesisId));
    }
  });

  return NextResponse.json(
    { success: true, count: tenantIds.length },
    { status: 200 },
  );
}
