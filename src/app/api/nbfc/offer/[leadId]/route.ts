/**
 * GET/POST /api/nbfc/offer/[leadId]
 *
 * BRD Addendum V0.2 §6.1 (Stage 1) — the firm financing conditions the acting
 * NBFC submits for a routed lead in its Acquire workspace. The customer
 * (dealer-mediated) later compares offers across picked NBFCs and selects the
 * winner (see /api/lead/[id]/select-winner).
 *
 *   GET  → the acting tenant's current offer for this lead (or null).
 *   POST → upsert the offer; sets nbfc_lead_assignments.status='offer_submitted'.
 *
 * Role: `credit_underwriting` (owns the offer/sanction terms, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dualApprovalRequests, nbfcFinancingOffers, nbfcLeadAssignments, nbfcLoanProducts } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { createDualApprovalRequest, FINANCING_OFFER_DEVIATION_ACTION } from "@/lib/nbfc/dual-approval/service";
import { computeOfferDeviation, type DeviationResult } from "@/lib/nbfc/offer-deviation";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const numStr = (v: number | string | null | undefined): string | null =>
  v == null || v === "" ? null : String(v);

// Every offer detail is mandatory; only `conditions` is optional. A valid number
// (incl. 0, e.g. a ₹0 processing fee) is required for the numeric fields and a
// date for `valid_until`. Mirrors the OfferPanel button gate so the API can't be
// bypassed with a blank firm offer.
const REQUIRED_NUMERIC = [
  "loan_amount",
  "roi_pct",
  "emi_amount",
  "tenure_months",
  "down_payment",
  "processing_fee",
] as const;

const Body = z
  .object({
    roi_pct: z.union([z.number(), z.string()]).optional().nullable(),
    emi_amount: z.union([z.number(), z.string()]).optional().nullable(),
    tenure_months: z.union([z.number(), z.string()]).optional().nullable(),
    loan_amount: z.union([z.number(), z.string()]).optional().nullable(),
    down_payment: z.union([z.number(), z.string()]).optional().nullable(),
    processing_fee: z.union([z.number(), z.string()]).optional().nullable(),
    conditions: z.string().max(4000).optional().nullable(),
    valid_until: z.string().optional().nullable(),
  })
  .superRefine((d, ctx) => {
    for (const k of REQUIRED_NUMERIC) {
      const v = d[k];
      if (v == null || String(v).trim() === "" || Number.isNaN(Number(v))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required` });
      }
    }
    if (!d.valid_until || d.valid_until.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valid_until"], message: "valid_until is required" });
    }
  });

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }
    const [offer] = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
      .limit(1);
    const canAct = actor.role === "credit_underwriting" || actor.role === "nbfc_admin";
    const locked = assignment.status === "selected" || assignment.status === "not_selected";
    return NextResponse.json({
      ok: true,
      assignment_status: assignment.status,
      can_act: canAct && !locked,
      offer: offer ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot submit a financing offer; credit_underwriting or nbfc_admin required` },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" }, { status: 400 });
    }
    if (assignment.status === "selected" || assignment.status === "not_selected") {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: a winner has already been decided (status '${assignment.status}') — offer is locked` },
        { status: 400 },
      );
    }

    // §13.3.3 — deviation check. Compare the offer against the matched loan
    // product's bands (pinned on the assignment). No product pinned (legacy
    // rows) → no bands to violate → treated as in-band (not_required), so the
    // existing flow is unchanged.
    let deviation: DeviationResult = { detected: false, fields: [], reason: null };
    if (assignment.loan_product_id != null) {
      const [product] = await db
        .select({
          min_roi_pct: nbfcLoanProducts.min_roi_pct,
          max_roi_pct: nbfcLoanProducts.max_roi_pct,
          tenure_months_min: nbfcLoanProducts.tenure_months_min,
          tenure_months_max: nbfcLoanProducts.tenure_months_max,
          loan_amount_min: nbfcLoanProducts.loan_amount_min,
          loan_amount_max: nbfcLoanProducts.loan_amount_max,
        })
        .from(nbfcLoanProducts)
        .where(eq(nbfcLoanProducts.id, assignment.loan_product_id))
        .limit(1);
      if (product) {
        deviation = computeOfferDeviation(
          {
            roi_pct: d.roi_pct == null ? null : Number(d.roi_pct),
            tenure_months: d.tenure_months == null || d.tenure_months === "" ? null : Number(d.tenure_months),
            loan_amount: d.loan_amount == null ? null : Number(d.loan_amount),
          },
          {
            min_roi_pct: Number(product.min_roi_pct),
            max_roi_pct: Number(product.max_roi_pct),
            tenure_months_min: product.tenure_months_min,
            tenure_months_max: product.tenure_months_max,
            loan_amount_min: product.loan_amount_min,
            loan_amount_max: product.loan_amount_max,
          },
        );
      }
    }
    // An out-of-band offer is HELD (ceo_approval_status='pending') and not
    // released to the dealer until the iTarang CEO approves; in-band releases
    // immediately exactly as before.
    const ceoStatus = deviation.detected ? "pending" : "not_required";

    const now = new Date();
    const values = {
      assignment_id: assignment.id,
      lead_id: leadId,
      nbfc_id: assignment.nbfc_id,
      tenant_id: actor.tenant_id,
      roi_pct: numStr(d.roi_pct),
      emi_amount: numStr(d.emi_amount),
      tenure_months: d.tenure_months == null || d.tenure_months === "" ? null : Number(d.tenure_months),
      loan_amount: numStr(d.loan_amount),
      down_payment: numStr(d.down_payment),
      processing_fee: numStr(d.processing_fee),
      conditions: d.conditions ?? null,
      valid_until: d.valid_until ? d.valid_until : null,
      status: "active" as const,
      deviation_detected: deviation.detected,
      deviation_fields: deviation.detected ? deviation.fields : null,
      deviation_reason: deviation.reason,
      ceo_approval_status: ceoStatus,
      submitted_by: actor.user_id,
      submitted_at: now,
      updated_at: now,
    };

    const [offerRow] = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(nbfcFinancingOffers)
        .values(values)
        .onConflictDoUpdate({
          target: nbfcFinancingOffers.assignment_id,
          set: {
            roi_pct: values.roi_pct,
            emi_amount: values.emi_amount,
            tenure_months: values.tenure_months,
            loan_amount: values.loan_amount,
            down_payment: values.down_payment,
            processing_fee: values.processing_fee,
            conditions: values.conditions,
            valid_until: values.valid_until,
            status: "active",
            deviation_detected: values.deviation_detected,
            deviation_fields: values.deviation_fields,
            deviation_reason: values.deviation_reason,
            ceo_approval_status: ceoStatus,
            submitted_by: values.submitted_by,
            submitted_at: now,
            updated_at: now,
          },
        })
        .returning();

      // Advance the assignment so the dealer's winner-selection screen surfaces
      // it — but ONLY when released (not held for CEO approval). Don't downgrade
      // a row already past offer_submitted.
      if (ceoStatus !== "pending" && (assignment.status === "pending" || assignment.status === "in_progress")) {
        await tx
          .update(nbfcLeadAssignments)
          .set({ status: "offer_submitted", updated_at: now })
          .where(eq(nbfcLeadAssignments.id, assignment.id));
      }
      return rows;
    });

    // Reconcile the CEO approval request to the offer's gate state.
    if (ceoStatus === "pending") {
      // Reuse an already-pending request (resubmit with still-out-of-band terms);
      // otherwise open a fresh one (first submission, or re-deviating after a
      // prior decision). §3.6 — surfaces for a human; never auto-decides.
      const [existing] = await db
        .select({ id: dualApprovalRequests.id })
        .from(dualApprovalRequests)
        .where(
          and(
            eq(dualApprovalRequests.action_type, FINANCING_OFFER_DEVIATION_ACTION),
            eq(dualApprovalRequests.entity_id, offerRow.id),
            eq(dualApprovalRequests.status, "pending_approval"),
          ),
        )
        .limit(1);
      let requestId = existing?.id ?? null;
      if (!requestId) {
        const created = await createDualApprovalRequest({
          tenant_id: actor.tenant_id,
          initiator_user_id: actor.user_id,
          action_type: FINANCING_OFFER_DEVIATION_ACTION,
          entity_id: offerRow.id,
          reason_code: "out_of_band_financing_offer",
          evidence_snapshot: {
            lead_id: leadId,
            nbfc_id: assignment.nbfc_id,
            offer: {
              roi_pct: values.roi_pct,
              tenure_months: values.tenure_months,
              loan_amount: values.loan_amount,
              emi_amount: values.emi_amount,
              down_payment: values.down_payment,
            },
            deviation_fields: deviation.fields,
            deviation_reason: deviation.reason,
          },
        });
        requestId = created.id;
      }
      await db
        .update(nbfcFinancingOffers)
        .set({ ceo_approval_request_id: requestId })
        .where(eq(nbfcFinancingOffers.id, offerRow.id));
    } else {
      // Resubmitted back within band: retire any still-pending request so it
      // doesn't linger in the CEO queue. (No-op for the common first-time
      // in-band submission — matches zero rows.)
      await db
        .update(dualApprovalRequests)
        .set({ status: "expired", expired_at: now })
        .where(
          and(
            eq(dualApprovalRequests.action_type, FINANCING_OFFER_DEVIATION_ACTION),
            eq(dualApprovalRequests.entity_id, offerRow.id),
            eq(dualApprovalRequests.status, "pending_approval"),
          ),
        );
    }

    return NextResponse.json({
      ok: true,
      status: ceoStatus === "pending" ? "pending_ceo_approval" : "offer_submitted",
      ceo_approval_status: ceoStatus,
      deviation: deviation.detected ? { fields: deviation.fields, reason: deviation.reason } : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
