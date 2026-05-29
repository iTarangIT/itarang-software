/**
 * GET/POST /api/nbfc/sanction/[leadId]
 *
 * BRD Addendum V0.2 §6.1 (disbursement) — the WINNING in-system NBFC sanctions
 * & disburses the loan from its Acquire workspace, after E-NACH is satisfied
 * (registered or waived). This writes the loan_sanctions row, advances the lead
 * to 'loan_sanctioned' (unlocking the dealer's Step 5 OTP + dispatch), and fires
 * the configurable `on_disbursal` wallet charge (§8.2).
 *
 *   GET  → gate state (is this tenant the winner? is E-NACH satisfied? already sanctioned?)
 *   POST → sanction & disburse.
 *
 * Role: `credit_underwriting` (owns sanction terms, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, nbfc, nbfcFinancingOffers, productSelections } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { evaluateTrackGate } from "@/lib/nbfc/track-gate";
import { postCharge } from "@/lib/nbfc/charging";
import { generateId } from "@/lib/api-utils";
import { notifyLoanSanctioned } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

async function loadContext(leadId: string, tenantId: string) {
  const assignment = await getActiveAssignment(leadId, tenantId);
  const [lead] = await db
    .select({ id: leads.id, kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  // §7.4 Track Rules — the unified gate composes FI + VKYC + E-NACH per the
  // lead's frozen config snapshot (E-NACH stays a §9.4 hard gate on its own).
  const gate = await evaluateTrackGate(leadId);
  return { assignment, lead, gate };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const { assignment, lead, gate } = await loadContext(leadId, actor.tenant_id);
    const isWinner = assignment?.status === "selected";
    const alreadySanctioned = lead?.kyc_status === "loan_sanctioned" || lead?.kyc_status === "sold";
    const canAct = (actor.role === "credit_underwriting" || actor.role === "nbfc_admin") && isWinner && !alreadySanctioned;
    return NextResponse.json({
      ok: true,
      is_winner: isWinner,
      already_sanctioned: alreadySanctioned,
      track_gate: gate,
      can_sanction: canAct && gate.satisfied,
      lead_status: lead?.kyc_status ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot sanction; credit_underwriting or nbfc_admin required` },
        { status: 403 },
      );
    }

    const { assignment, lead, gate } = await loadContext(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }
    if (assignment.status !== "selected") {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: this NBFC is not the selected winner (status '${assignment.status}')` },
        { status: 400 },
      );
    }
    if (!lead) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: lead" }, { status: 404 });
    }
    if (lead.kyc_status === "loan_sanctioned" || lead.kyc_status === "sold") {
      return NextResponse.json({ ok: true, already: true, lead_status: lead.kyc_status });
    }
    if (!gate.satisfied) {
      return NextResponse.json({ ok: false, error: `BAD_REQUEST: ${gate.reason}` }, { status: 400 });
    }

    // Firm terms from the submitted offer.
    const [offer] = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
      .limit(1);

    const [me] = await db
      .select({ short_name: nbfc.short_name, legal_name: nbfc.legal_name })
      .from(nbfc)
      .where(eq(nbfc.id, assignment.nbfc_id))
      .limit(1);

    const [selection] = await db
      .select({ id: productSelections.id })
      .from(productSelections)
      .where(and(eq(productSelections.lead_id, leadId), eq(productSelections.payment_mode, "finance")))
      .orderBy(productSelections.created_at)
      .limit(1);

    const loanSanctionId = await generateId("LS");
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(loanSanctions).values({
        id: loanSanctionId,
        lead_id: leadId,
        product_selection_id: selection?.id ?? null,
        nbfc_id: actor.tenant_id,
        loan_amount: offer?.loan_amount ?? null,
        down_payment: offer?.down_payment ?? null,
        emi: offer?.emi_amount ?? null,
        tenure_months: offer?.tenure_months ?? null,
        roi: offer?.roi_pct ?? null,
        loan_approved_by: me?.legal_name ?? me?.short_name ?? null,
        status: "sanctioned",
        sanctioned_by: actor.user_id,
        sanctioned_by_type: "nbfc",
        sanctioned_at: now,
        disbursed_at: now,
        created_at: now,
        updated_at: now,
      });

      await tx
        .update(leads)
        .set({ kyc_status: "loan_sanctioned", updated_at: now })
        .where(eq(leads.id, leadId));
    });

    // §8.2 — fire the configurable on_disbursal wallet charge for the winning
    // NBFC. Best-effort: the loan is already sanctioned, so a ledger hiccup must
    // not roll it back.
    let ledgerIds: string[] = [];
    try {
      ledgerIds = await postCharge({
        tenantId: actor.tenant_id,
        trigger: "on_disbursal",
        leadId,
        nbfcId: assignment.nbfc_id,
        postedBy: actor.user_id,
        descriptionSuffix: `Disbursal · lead ${leadId}`,
      });
    } catch (chargeErr) {
      console.error("[NBFC sanction] on_disbursal charge failed:", chargeErr);
    }

    notifyLoanSanctioned({
      leadId,
      loanSanctionId,
      lenderName: me?.legal_name ?? me?.short_name ?? "NBFC",
      loanAmount: offer?.loan_amount ? Number(offer.loan_amount) : 0,
      emi: offer?.emi_amount ? Number(offer.emi_amount) : 0,
      tenureMonths: offer?.tenure_months ?? 0,
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      loan_sanction_id: loanSanctionId,
      lead_status: "loan_sanctioned",
      charged_ledger_ids: ledgerIds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[NBFC sanction] error:", e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
