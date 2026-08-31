/**
 * Step-4 "Send to NBFC" — the write, lifted out of the dealer route.
 *
 * WHY THIS EXISTS.
 *
 * `POST /api/lead/[id]/submit-product-selection` was the only way a lead could
 * be routed to its lenders, and every line of it below the auth check is
 * channel-agnostic. E-264 Phase 2 lets the customer make the same choice inside
 * WhatsApp, where there is no Supabase session to hand `requireRole("dealer")`
 * and no request to parse — so the route's body had to become callable without
 * either.
 *
 * The split is deliberately at the auth boundary, not at the transaction:
 *   route  → who is asking, may they, is this lead eligible, HTTP shaping
 *   here   → the product_selections row, the Acquire fan-out, the lead advance,
 *            the audit-visible notifications
 *
 * Anything that decides *whether* the submit may happen stays with the caller,
 * because the two callers answer it differently (a dealer session vs. a phone
 * number that authorizeLeadAction has already matched to the lead). Anything
 * that decides *what gets written* lives here exactly once — the same reasoning
 * that produced `productSelectionSchema.ts`, and for the same failure it
 * prevents: two writers drifting until one of them silently stops populating
 * `nbfc_lead_assignments` and the lead never appears in an Acquire queue.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  loanSanctions,
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  nbfcServiceConfig,
  productSelections,
} from "@/lib/db/schema";
import {
  BAJAJ_FALLBACK,
  externalLenderName,
  recordNoPreferredPartner,
} from "@/lib/leads/bajaj-fallback";
import { notifyLoanSanctioned } from "@/lib/notifications";
import { generateId } from "@/lib/api-utils";
import { notifyProductSelectionSubmitted } from "@/lib/notifications";
import { notifyProductSubmitted } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";
import {
  productSelectionColumns,
  type SubmitProductSelectionBody,
} from "@/lib/leads/productSelectionSchema";
import { buildServiceSnapshot } from "@/lib/nbfc/service-snapshot";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";

/** The `kyc_status` values from which Step 4 may be submitted. */
export const STEP4_UNLOCKED_STATUSES = new Set([
  "step_3_cleared",
  "kyc_approved",
]);

export interface Step4SubmitResult {
  productSelectionId: string;
  /** NBFC display codes + product names actually bound, post-commit. */
  routedTo: Array<{ code: string; product: string | null }>;
  /**
   * E-275 — set when the dealer took the off-platform lender card. The lead
   * is already `loan_sanctioned`; the caller should send the dealer to Step 5.
   */
  externalLender?: { id: string; name: string; loanSanctionId: string };
}

/**
 * Write the Step-4 selection and fan the lead out to its lenders.
 *
 * The caller owns authorisation and eligibility. Throws on a database failure;
 * the notification sends are best-effort and never throw.
 */
export async function submitStep4ProductSelection(opts: {
  leadId: string;
  /** Lead row fields this write depends on. */
  lead: { product_category_id: string | null; product_type_id: string | null };
  body: SubmitProductSelectionBody;
  /** `users.id` recorded as `product_selections.submitted_by`. */
  submittedBy: string;
  /** The lead's dealer code, for the notification's dealer name. */
  dealerCode: string | null;
}): Promise<Step4SubmitResult> {
  const { leadId, lead, body, submittedBy, dealerCode } = opts;

  if (body.selectedNbfcs && body.selectedNbfcs.length > 1) {
    throw new Error("Only one lending partner may be selected.");
  }

  const productSelectionId = await generateId("PS");
  const now = new Date();

  // E-275 — off-platform lender ("Bajaj Finance"). No NBFC ever sees this
  // file: no assignment row, no NBFC notification. The lead is sanctioned on
  // the spot so Step 5 (cart → OTP → dispatch) opens immediately.
  if (body.externalLender) {
    const lenderName = externalLenderName(body.externalLender) ?? BAJAJ_FALLBACK.name;
    const loanSanctionId = await generateId("LS");
    const [leadRow] = await db
      .select({ requested_loan_amount: leads.requested_loan_amount })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const loanAmount = leadRow?.requested_loan_amount ?? null;

    await db.transaction(async (tx) => {
      await tx
        .delete(productSelections)
        .where(
          and(
            eq(productSelections.lead_id, leadId),
            eq(productSelections.admin_decision, "draft"),
          ),
        );
      await tx.insert(productSelections).values({
        id: productSelectionId,
        lead_id: leadId,
        ...productSelectionColumns(body),
        category: body.category || lead.product_category_id,
        model_number: body.modelNumber || lead.product_type_id,
        payment_mode: "finance",
        admin_decision: "accepted",
        pre_sanction_doc_urls: body.preSanctionDocs ?? [],
        selected_nbfcs: [],
        external_lender: body.externalLender,
        customer_disclosure_ack: body.customerDisclosureAck ?? false,
        submitted_by: submittedBy,
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });
      await tx.insert(loanSanctions).values({
        id: loanSanctionId,
        lead_id: leadId,
        product_selection_id: productSelectionId,
        loan_amount: loanAmount == null ? null : String(loanAmount),
        loan_approved_by: lenderName,
        status: "sanctioned",
        external_lender: body.externalLender,
        // E-130 CHECK allows only 'admin' | 'nbfc_user' | NULL here; the
        // off-platform lender is discriminated by `external_lender` instead.
        sanctioned_by: null,
        sanctioned_by_type: null,
        sanctioned_at: now,
        created_at: now,
        updated_at: now,
      });
      await tx
        .update(leads)
        .set({ kyc_status: "loan_sanctioned", updated_at: now })
        .where(eq(leads.id, leadId));
    });

    await recordNoPreferredPartner({ leadId, actorUserId: submittedBy });
    notifyProductSelectionSubmitted({
      leadId,
      productSelectionId,
      paymentMode: "finance",
      finalPrice: body.finalPrice ?? null,
    }).catch(() => {});
    notifyLoanSanctioned({
      leadId,
      loanSanctionId,
      lenderName,
      loanAmount: loanAmount ?? 0,
      emi: 0,
      tenureMonths: 0,
    }).catch(() => {});
    notifyProductSubmitted({
      leadId,
      productSelectionId,
      paymentMode: "finance",
      finalPrice: body.finalPrice ?? null,
      nbfcNames: [`${lenderName} (outside partner)`],
      loanProduct: null,
      dealerName: await dealerDisplayName(dealerCode ?? ""),
    }).catch(() => {});

    return {
      productSelectionId,
      routedTo: [{ code: lenderName, product: null }],
      externalLender: { id: body.externalLender, name: lenderName, loanSanctionId },
    };
  }

  await db.transaction(async (tx) => {
    // Clear any existing draft row for this lead so it disappears from
    // /My Drafts. The submitted row below replaces it as the canonical
    // selection. Done inside the transaction so partial state is impossible.
    await tx
      .delete(productSelections)
      .where(
        and(
          eq(productSelections.lead_id, leadId),
          eq(productSelections.admin_decision, "draft"),
        ),
      );

    await tx.insert(productSelections).values({
      id: productSelectionId,
      lead_id: leadId,
      ...productSelectionColumns(body),
      category: body.category || lead.product_category_id,
      model_number: body.modelNumber || lead.product_type_id,
      payment_mode: "finance",
      admin_decision: "pending",
      pre_sanction_doc_urls: body.preSanctionDocs ?? [],
      selected_nbfcs: body.selectedNbfcs ?? [],
      customer_disclosure_ack: body.customerDisclosureAck ?? false,
      submitted_by: submittedBy,
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });

    // Inventory is deliberately NOT reserved here — the serial is picked on
    // Step 5 and reserved inside confirm-dispatch.

    await tx
      .update(leads)
      .set({ kyc_status: "pending_final_approval", updated_at: now })
      .where(eq(leads.id, leadId));

    // E-131 / Addendum V0.1 §6 — fan out to NBFC Acquire queues. One row
    // per picked NBFC. tenant_id is denormalised from nbfc.tenant_id so
    // the queue page is a single tenant-scoped index hit. selected_nbfcs
    // stores nbfc.id (integer PK) as a stringified integer per the Section
    // G writer; we parseInt and drop anything non-numeric or referencing
    // an nbfc row without a tenant binding (legacy / E-026B-style rows).
    // onConflictDoNothing on (lead_id, nbfc_id) makes re-submits safe.
    if (body.selectedNbfcs && body.selectedNbfcs.length > 0) {
      const picks = body.selectedNbfcs
        .map((p) => ({
          nbfc_id: Number(p.nbfc_id),
          loan_product_id:
            p.loan_product_id == null ? null : Number(p.loan_product_id),
        }))
        .filter(
          (p) =>
            Number.isFinite(p.nbfc_id) &&
            (p.loan_product_id == null || Number.isFinite(p.loan_product_id)),
        );

      if (picks.length > 0) {
        const nbfcRows = await tx
          .select({ id: nbfc.id, tenant_id: nbfc.tenant_id })
          .from(nbfc)
          .where(inArray(nbfc.id, picks.map((p) => p.nbfc_id)));

        const tenantByNbfc = new Map(
          nbfcRows.map((r) => [r.id, r.tenant_id] as const),
        );

        // E-133 / Addendum V0.2 §7.4 — load each bound NBFC's current
        // service-opt-in config so we can freeze a per-lead snapshot.
        const tenantIds = [
          ...new Set(
            nbfcRows
              .map((r) => r.tenant_id)
              .filter((t): t is string => Boolean(t)),
          ),
        ];
        const cfgRows = tenantIds.length
          ? await tx
              .select()
              .from(nbfcServiceConfig)
              .where(inArray(nbfcServiceConfig.tenant_id, tenantIds))
          : [];
        const cfgByTenant = new Map(cfgRows.map((c) => [c.tenant_id, c] as const));

        const assignmentRows = picks
          .map((p) => {
            const tenantId = tenantByNbfc.get(p.nbfc_id);
            if (!tenantId) {
              console.warn(
                `[submit-step4] skipping Acquire fan-out for nbfc.id=${p.nbfc_id} — no tenant_id binding. Lead ${leadId} will not surface in this NBFC's Acquire queue until the nbfc row is repointed.`,
              );
              return null;
            }
            return {
              lead_id: leadId,
              nbfc_id: p.nbfc_id,
              tenant_id: tenantId,
              loan_product_id: p.loan_product_id,
              status: "pending" as const,
              service_config_snapshot: buildServiceSnapshot(
                cfgByTenant.get(tenantId),
                now,
              ),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        if (assignmentRows.length > 0) {
          await tx
            .insert(nbfcLeadAssignments)
            .values(assignmentRows)
            .onConflictDoNothing({
              target: [
                nbfcLeadAssignments.lead_id,
                nbfcLeadAssignments.nbfc_id,
              ],
            });
        }
      }
    }
  });

  notifyProductSelectionSubmitted({
    leadId,
    productSelectionId,
    paymentMode: "finance",
    finalPrice: body.finalPrice ?? null,
  }).catch(() => {});

  // Admin + the picked NBFCs. Carries WHICH lenders and WHICH loan product was
  // selected — the first thing anyone asks when a Step-4 submission lands, and
  // the reason this is more than a bare "Step 4 submitted". Resolved after the
  // transaction so the names come from committed rows.
  const picked = await db
    .select({
      name: nbfc.legal_name,
      short: nbfc.short_name,
      code: nbfc.nbfc_id,
      product: nbfcLoanProducts.product_name,
      tenant_id: nbfcLeadAssignments.tenant_id,
    })
    .from(nbfcLeadAssignments)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLeadAssignments.nbfc_id))
    .leftJoin(
      nbfcLoanProducts,
      eq(nbfcLoanProducts.id, nbfcLeadAssignments.loan_product_id),
    )
    .where(eq(nbfcLeadAssignments.lead_id, leadId));

  const submitDealerName = await dealerDisplayName(dealerCode ?? "");
  await notifyProductSubmitted({
    leadId,
    productSelectionId,
    paymentMode: "finance",
    finalPrice: body.finalPrice ?? null,
    nbfcNames: picked.map((p) => p.name || p.short || "").filter(Boolean),
    loanProduct:
      picked.map((p) => p.product).filter(Boolean).join(", ") || null,
    dealerName: submitDealerName,
  });

  // E-276 — contact-email copy to each routed NBFC (+ global monitoring CC).
  {
    const [leadRow2] = await db
      .select({
        full_name: leads.full_name,
        owner_name: leads.owner_name,
        requested_loan_amount: leads.requested_loan_amount,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const customerName = leadRow2?.full_name ?? leadRow2?.owner_name ?? "the customer";
    for (const p of picked) {
      if (!p.tenant_id) continue;
      sendNbfcEventEmail({
        tenantId: p.tenant_id,
        leadId,
        subject: `iTarang — New loan file routed to you (Lead ${leadId})`,
        eventLabel: `Dealer ${submitDealerName} has sent a new customer loan file to your NBFC account.`,
        customerName,
        dealerName: submitDealerName,
        extraRows: [
          ["Loan product", p.product],
          [
            "Requested loan amount",
            leadRow2?.requested_loan_amount ? `₹${leadRow2.requested_loan_amount}` : null,
          ],
          ["Final price", body.finalPrice != null ? `₹${body.finalPrice}` : null],
        ],
        bodyHtml: `<p>Update: the file is now in your <b>Acquire queue</b> awaiting your review — verify the customer's KYC documents and submit your financing offer from the NBFC dashboard.</p>`,
      }).catch(() => {});
    }
  }

  return {
    productSelectionId,
    routedTo: picked.map((p) => ({
      code: p.code || p.short || "",
      product: p.product ?? null,
    })),
  };
}
