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
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
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
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
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
      submitted_by: actor.user_id,
      submitted_at: now,
      updated_at: now,
    };

    await db.transaction(async (tx) => {
      await tx
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
            submitted_by: values.submitted_by,
            submitted_at: now,
            updated_at: now,
          },
        });

      // Advance the assignment so the dealer's winner-selection screen surfaces
      // it. Don't downgrade a row already past offer_submitted.
      if (assignment.status === "pending" || assignment.status === "in_progress") {
        await tx
          .update(nbfcLeadAssignments)
          .set({ status: "offer_submitted", updated_at: now })
          .where(eq(nbfcLeadAssignments.id, assignment.id));
      }
    });

    return NextResponse.json({ ok: true, status: "offer_submitted" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
