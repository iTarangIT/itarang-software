import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfc, riskHypotheses, nbfcRiskCardVisibility } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// E-199 — Per-NBFC risk-card visibility allowlist.
//
// GET  → the global (non-retired) risk-hypothesis catalogue plus the set of
//        hypothesis_ids currently enabled for this NBFC's tenant, so the admin
//        form can pre-check.
// PUT  → replace the tenant's enabled set with the posted hypothesis_ids.
//
// The path param is the INTEGER nbfc.id (the admin onboarding entity). Risk
// cards live on the uuid nbfc_tenants side; we bridge via nbfc.tenant_id
// (set at activation, E-139). A not-yet-activated NBFC has tenant_id = null and
// cannot have card visibility configured.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNbfcId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

const putBodySchema = z.object({
  hypothesis_ids: z.array(z.string().uuid()).default([]),
});

/**
 * Resolve the integer nbfcId to its uuid portal tenant. Returns a ready-to-send
 * error response when the NBFC is missing or not yet activated (no tenant).
 */
async function resolveTenant(nbfcId: number): Promise<
  { ok: true; tenantId: string } | { ok: false; response: NextResponse }
> {
  const [row] = await db
    .select({ tenant_id: nbfc.tenant_id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "NBFC not found" },
        { status: 404 },
      ),
    };
  }
  if (!row.tenant_id) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          message:
            "This NBFC has no portal tenant yet — activate the NBFC before configuring risk cards.",
          nbfcStatus: row.status,
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true, tenantId: row.tenant_id };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = parseNbfcId(nbfcIdRaw);
  if (nbfcId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const tenant = await resolveTenant(nbfcId);
  if (!tenant.ok) return tenant.response;

  // The full catalogue an admin may choose from — every non-retired hypothesis,
  // hand-coded and AI-generated alike. Retired ones can never be shown, so they
  // are not offered.
  const catalogue = await db
    .select({
      id: riskHypotheses.id,
      slug: riskHypotheses.slug,
      title: riskHypotheses.title,
      description: riskHypotheses.description,
      source: riskHypotheses.source,
    })
    .from(riskHypotheses)
    .where(isNull(riskHypotheses.retired_at))
    .orderBy(riskHypotheses.source, riskHypotheses.slug);

  const selectedRows = await db
    .select({ hypothesis_id: nbfcRiskCardVisibility.hypothesis_id })
    .from(nbfcRiskCardVisibility)
    .where(eq(nbfcRiskCardVisibility.tenant_id, tenant.tenantId));

  return NextResponse.json(
    {
      success: true,
      catalogue,
      selected: selectedRows.map((r) => r.hypothesis_id),
    },
    { status: 200 },
  );
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = parseNbfcId(nbfcIdRaw);
  if (nbfcId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid nbfcId" },
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

  const tenant = await resolveTenant(nbfcId);
  if (!tenant.ok) return tenant.response;

  // De-dupe and drop any id that isn't a real, non-retired hypothesis — a stale
  // or retired id in the request must never mint a visibility row that can never
  // render.
  const requested = [...new Set(parsed.data.hypothesis_ids)];
  let valid: string[] = [];
  if (requested.length > 0) {
    const rows = await db
      .select({ id: riskHypotheses.id })
      .from(riskHypotheses)
      .where(and(inArray(riskHypotheses.id, requested), isNull(riskHypotheses.retired_at)));
    valid = rows.map((r) => r.id);
  }

  await db.transaction(async (tx) => {
    // Remove anything no longer selected.
    if (valid.length > 0) {
      await tx
        .delete(nbfcRiskCardVisibility)
        .where(
          and(
            eq(nbfcRiskCardVisibility.tenant_id, tenant.tenantId),
            notInArray(nbfcRiskCardVisibility.hypothesis_id, valid),
          ),
        );
      // Insert the newly selected; the unique (tenant_id, hypothesis_id) index
      // makes re-selecting an already-enabled card a no-op.
      await tx
        .insert(nbfcRiskCardVisibility)
        .values(
          valid.map((hypothesis_id) => ({
            tenant_id: tenant.tenantId,
            hypothesis_id,
            updated_by: auth.user.id,
          })),
        )
        .onConflictDoNothing({
          target: [nbfcRiskCardVisibility.tenant_id, nbfcRiskCardVisibility.hypothesis_id],
        });
    } else {
      // Empty selection clears the tenant entirely (strict allowlist → 0 cards).
      await tx
        .delete(nbfcRiskCardVisibility)
        .where(eq(nbfcRiskCardVisibility.tenant_id, tenant.tenantId));
    }
  });

  return NextResponse.json(
    { success: true, selected: valid, count: valid.length },
    { status: 200 },
  );
}
