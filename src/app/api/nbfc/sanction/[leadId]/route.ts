/**
 * GET/POST /api/nbfc/sanction/[leadId]
 *
 * BRD Addendum V0.2 §6.1 — the WINNING in-system NBFC sanctions, then
 * disburses, the loan from its Acquire workspace.
 *
 * 23 Nov 2026 — Sanction and Disbursement used to be ONE click that wrote both
 * timestamps. They are now two statuses / two actions:
 *
 *   GET  → gate state (winner? tracks satisfied? sanctioned? disbursed?)
 *   POST {action:"sanction"} (default) → Sanction only: loan_sanctions row
 *        'sanctioned' (disbursed_at NULL), lead → 'loan_sanctioned' (opens the
 *        dealer's Step 5 OTP + dispatch). Shown in the E-NACH & Agreement step.
 *   POST {action:"disburse", amount?, reference?} → Disburse: the sanctioned row
 *        → 'disbursed' + disbursed_at, the on_disbursal wallet charge (§8.2) and
 *        the disbursement notices. The last step's card + button ("Disburse").
 *
 * Role: `credit_underwriting` (owns sanction terms, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, nbfc, nbfcFinancingOffers, productSelections } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { hierarchyBlock } from "@/lib/nbfc/approval-hierarchy-http";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { evaluateTrackGate } from "@/lib/nbfc/track-gate";
import { evaluateAgreementGate, type AgreementMethod } from "@/lib/nbfc/agreement";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";
import { syncLoanAgreementStatusFromDigio } from "@/lib/nbfc/sync-loan-agreement-status";
import { postCharge } from "@/lib/nbfc/charging";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";
import { generateId } from "@/lib/api-utils";
import { notifyLoanSanctioned } from "@/lib/notifications";
import { notifyLoanDisbursed, notifyLoanSanctionedEvent } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

/**
 * Drizzle wraps driver errors as `Failed query: …`; the real Postgres message
 * (constraint name, etc.) lives on the `.cause` chain. Surface the deepest one
 * so the UI shows the actual reason instead of the opaque wrapper.
 */
function unwrapDbError(e: unknown): string {
  let cur: unknown = e;
  let msg = e instanceof Error ? e.message : String(e);
  while (cur instanceof Error && (cur as { cause?: unknown }).cause) {
    cur = (cur as { cause?: unknown }).cause;
    if (cur instanceof Error && cur.message) msg = cur.message;
  }
  return msg;
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

  // Agreement status — advisory only (§17.5, Step-5 OTP is the hard gate). The
  // method is read LIVE, so "Not through iTarang" drops the rail here too.
  const agreementMethod: AgreementMethod | null = assignment
    ? (await resolveServiceOptIn(tenantId, assignment.snapshot)).doc_agreement_method
    : null;
  // Reconcile against Digio first so a signed agreement surfaces even when the
  // webhook never arrived (local dev / missed callback). Best-effort.
  if (assignment) {
    await syncLoanAgreementStatusFromDigio(leadId, assignment.nbfc_id).catch(() => {});
  }
  const agreement_gate = await evaluateAgreementGate(leadId, assignment?.nbfc_id ?? null, agreementMethod);
  return { assignment, lead, gate, agreement_gate };
}

/** This tenant's sanction row for the lead (newest), if any. */
async function latestSanction(leadId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(loanSanctions)
    .where(and(eq(loanSanctions.lead_id, leadId), eq(loanSanctions.nbfc_id, tenantId)))
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);
  return row ?? null;
}

const POST_SANCTION_STATUSES = ["loan_sanctioned", "dispatched", "sold"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const { assignment, lead, gate, agreement_gate } = await loadContext(leadId, actor.tenant_id);
    const isWinner = assignment?.status === "selected";
    const loan = await latestSanction(leadId, actor.tenant_id);
    const alreadySanctioned = !!loan || POST_SANCTION_STATUSES.includes(lead?.kyc_status ?? "");
    const alreadyDisbursed = loan?.status === "disbursed" || !!loan?.disbursed_at;
    const roleOk = actor.role === "credit_underwriting" || actor.role === "nbfc_admin";
    return NextResponse.json({
      ok: true,
      is_winner: isWinner,
      already_sanctioned: alreadySanctioned,
      already_disbursed: alreadyDisbursed,
      track_gate: gate,
      agreement_gate,
      can_sanction: roleOk && isWinner && !alreadySanctioned && gate.satisfied,
      can_disburse: roleOk && isWinner && !!loan && !alreadyDisbursed,
      loan: loan
        ? {
            id: loan.id,
            status: loan.status,
            loan_amount: loan.loan_amount,
            emi: loan.emi,
            tenure_months: loan.tenure_months,
            sanctioned_at: loan.sanctioned_at?.toISOString() ?? null,
            disbursed_at: loan.disbursed_at?.toISOString() ?? null,
            disbursement_amount: loan.disbursement_amount,
            reference: loan.dealer_payment_utr,
          }
        : null,
      lead_status: lead?.kyc_status ?? null,
    });
  } catch (e) {
    const msg = unwrapDbError(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    // E-387 — parent/child CIBIL approval hierarchy gate.
    const hierarchyBlocked = await hierarchyBlock(actor, leadId, "sanction");
    if (hierarchyBlocked) return hierarchyBlocked;
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot sanction or disburse; credit_underwriting or nbfc_admin required`,
        },
        { status: 403 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      amount?: number | string | null;
      reference?: string | null;
    };
    if (body.action === "disburse") return await disburse(leadId, actor, body);
    return await sanction(leadId, actor);
  } catch (e) {
    const msg = unwrapDbError(e);
    console.error("[NBFC sanction] error:", e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

type Actor = Awaited<ReturnType<typeof resolveActor>>;

async function lenderOf(nbfcId: number) {
  const [me] = await db
    .select({ short_name: nbfc.short_name, legal_name: nbfc.legal_name })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  return { me, lenderName: me?.legal_name ?? me?.short_name ?? "NBFC" };
}

async function leadContact(leadId: string) {
  const [leadRow] = await db
    .select({ full_name: leads.full_name, owner_name: leads.owner_name, dealer_id: leads.dealer_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return {
    customerName: leadRow?.full_name ?? leadRow?.owner_name ?? null,
    dealerName: await dealerDisplayName(leadRow?.dealer_id),
  };
}

async function sanction(leadId: string, actor: Actor) {
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
  const existing = await latestSanction(leadId, actor.tenant_id);
  if (existing || POST_SANCTION_STATUSES.includes(lead.kyc_status ?? "")) {
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
  const { me, lenderName } = await lenderOf(assignment.nbfc_id);

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
      // Discriminator for the sanctioned_by uuid (§E-130). The DB CHECK allows
      // only 'admin' | 'nbfc_user' — an NBFC user sanctions here.
      sanctioned_by_type: "nbfc_user",
      sanctioned_at: now,
      // NOT disbursed yet — the separate Disburse action stamps this.
      disbursed_at: null,
      created_at: now,
      updated_at: now,
    });
    await tx.update(leads).set({ kyc_status: "loan_sanctioned", updated_at: now }).where(eq(leads.id, leadId));
  });

  // Dealer copy (Step-5 nudge) + the admin / NBFC bell.
  notifyLoanSanctioned({
    leadId,
    loanSanctionId,
    lenderName,
    loanAmount: offer?.loan_amount ? Number(offer.loan_amount) : 0,
    emi: offer?.emi_amount ? Number(offer.emi_amount) : 0,
    tenureMonths: offer?.tenure_months ?? 0,
  }).catch(() => {});
  await notifyLoanSanctionedEvent({
    leadId,
    lenderName,
    tenantId: actor.tenant_id,
    loanAmount: offer?.loan_amount ?? null,
  });

  // E-276 — contact-email copy to the sanctioning NBFC (+ global monitoring CC).
  (async () => {
    const c = await leadContact(leadId);
    await sendNbfcEventEmail({
      tenantId: actor.tenant_id,
      leadId,
      subject: `iTarang — Loan sanctioned by ${lenderName} (Lead ${leadId})`,
      eventLabel: `${lenderName} has sanctioned the loan for Lead ${leadId}. Disbursement is a separate step.`,
      customerName: c.customerName,
      dealerName: c.dealerName,
      extraRows: [
        ["Lender", lenderName],
        ["Loan amount", offer?.loan_amount ? `₹${offer.loan_amount}` : null],
        ["EMI", offer?.emi_amount ? `₹${offer.emi_amount}` : null],
        ["Tenure", offer?.tenure_months ? `${offer.tenure_months} months` : null],
        ["Sanction ID", loanSanctionId],
      ],
      bodyHtml: `<p>Update: the customer now proceeds to Step 5 (battery selection, OTP and dispatch). Use <b>Disburse</b> in the NBFC portal once the money is released.</p>`,
    });
  })().catch(() => {});

  // E-264 — Step 5 begins for the customer (WhatsApp `sanctioned` template).
  void import("@/lib/whatsapp/offer-flow")
    .then(({ pushSanctionedToWhatsApp }) =>
      pushSanctionedToWhatsApp(leadId, offer?.loan_amount ?? null, offer?.emi_amount ?? null),
    )
    .catch((err) => console.error("[nbfc/sanction] WhatsApp push failed:", err));

  return NextResponse.json({ ok: true, loan_sanction_id: loanSanctionId, lead_status: "loan_sanctioned" });
}

async function disburse(
  leadId: string,
  actor: Actor,
  body: { amount?: number | string | null; reference?: string | null },
) {
  const assignment = await getActiveAssignment(leadId, actor.tenant_id);
  if (!assignment || assignment.status !== "selected") {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST: this NBFC is not the selected winner for this lead" },
      { status: 400 },
    );
  }
  const loan = await latestSanction(leadId, actor.tenant_id);
  if (!loan) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST: sanction the loan first (E-NACH & Agreement step)" },
      { status: 400 },
    );
  }
  if (loan.status === "disbursed" || loan.disbursed_at) {
    return NextResponse.json({ ok: true, already: true, loan_sanction_id: loan.id });
  }
  const rawAmount = body.amount == null || body.amount === "" ? null : Number(body.amount);
  if (rawAmount != null && (!Number.isFinite(rawAmount) || rawAmount <= 0)) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST: disbursement amount must be a positive number" },
      { status: 400 },
    );
  }
  const reference = body.reference?.toString().trim().slice(0, 64) || null;
  const amount = rawAmount ?? (loan.loan_amount != null ? Number(loan.loan_amount) : null);
  const now = new Date();

  const updated = await db
    .update(loanSanctions)
    .set({
      status: "disbursed",
      disbursed_at: now,
      disbursement_amount: amount != null ? String(amount) : loan.disbursement_amount,
      // E-298 — funds released; the dealer now owes a "did it arrive?".
      dealer_payment_status: loan.dealer_payment_status ?? "pending",
      dealer_payment_utr: loan.dealer_payment_utr ?? reference,
      updated_at: now,
    })
    // Only from the status we read — a double click cannot disburse twice.
    .where(and(eq(loanSanctions.id, loan.id), eq(loanSanctions.status, loan.status)))
    .returning({ id: loanSanctions.id });
  if (!updated.length) {
    return NextResponse.json({ ok: true, already: true, loan_sanction_id: loan.id });
  }

  // §8.2 — the configurable on_disbursal wallet charge (moved here from Sanction).
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
    console.error("[NBFC disburse] on_disbursal charge failed:", chargeErr);
  }

  const { lenderName } = await lenderOf(assignment.nbfc_id);
  await notifyLoanDisbursed({
    leadId,
    lenderName,
    tenantId: actor.tenant_id,
    loanAmount: amount,
    sanctionId: loan.id,
    disbursedAt: now,
  });

  // B15 — the dealer's disbursement confirmation on WhatsApp.
  void import("@/lib/whatsapp/notifications")
    .then(({ sendDisbursementWhatsApp }) =>
      sendDisbursementWhatsApp({ leadId, loanAmount: amount, disbursedAt: now, sanctionId: loan.id }),
    )
    .then((r) => {
      if (r.error) console.error("[nbfc/disburse] disbursement WhatsApp not delivered:", r.error);
    })
    .catch((err) => console.error("[nbfc/disburse] disbursement WhatsApp failed:", err));

  // E-298 — ask the dealer to confirm the payout reached them (bell + WhatsApp
  // Received / Not received). Dispatch used to do this; for NBFC-portal loans
  // the money moves here.
  void import("@/lib/leads/dealer-payment-confirmation")
    .then(({ promptDealerForPayment }) =>
      promptDealerForPayment({ leadId, sanctionId: loan.id, lenderName, loanAmount: amount }),
    )
    .catch((err) => console.error("[nbfc/disburse] payment prompt failed:", err));

  (async () => {
    const c = await leadContact(leadId);
    await sendNbfcEventEmail({
      tenantId: actor.tenant_id,
      leadId,
      subject: `iTarang — Loan disbursed by ${lenderName} (Lead ${leadId})`,
      eventLabel: `${lenderName} has disbursed the loan for Lead ${leadId}.`,
      customerName: c.customerName,
      dealerName: c.dealerName,
      extraRows: [
        ["Lender", lenderName],
        ["Disbursed amount", amount != null ? `₹${amount}` : null],
        ["Reference / UTR", reference],
        ["Sanction ID", loan.id],
      ],
      bodyHtml: `<p>The loan is recorded as disbursed. The dealer is asked to confirm the money arrived.</p>`,
    });
  })().catch(() => {});

  return NextResponse.json({ ok: true, loan_sanction_id: loan.id, status: "disbursed", charged_ledger_ids: ledgerIds });
}
