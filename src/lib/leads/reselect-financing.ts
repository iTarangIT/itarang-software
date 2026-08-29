/**
 * E-245 / E-275 — route a lead to ANOTHER lender.
 *
 * Lifted out of `POST /api/lead/[id]/reselect-financing` so the WhatsApp
 * "Choose another NBFC" button (E-275, after an NBFC rejection) can bind the
 * same way the web card does. The route keeps auth + HTTP shaping; this module
 * owns the rules and the write, exactly once.
 *
 * Rules:
 *   - no winner yet;
 *   - at least one assignment has been FREED (`withdrawn` by the dealer,
 *     `declined` by the NBFC, or `not_selected`) — re-selection is the escape
 *     hatch from a closed/rejected file, not a way to keep adding lenders;
 *   - the NBFC has never been on this lead (UNIQUE(lead_id, nbfc_id));
 *   - at most ONE live assignment at a time (E-275: was two);
 *   - the (nbfcId, loanProductId) pair is re-matched server-side against the
 *     BRE with the lead's `requested_loan_amount`.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dealers,
  leads,
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  nbfcServiceConfig,
  productCategories,
  productSelections,
} from "@/lib/db/schema";
import {
  loadActiveProductsForDealer,
  matchProducts,
  type CustomerProfile,
} from "@/lib/bre";
import { buildServiceSnapshot } from "@/lib/nbfc/service-snapshot";
import { notifyLeadRerouted } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";

/** E-275 — a lead sits with at most ONE lender at a time. */
export const MAX_LIVE_ASSIGNMENTS = 1;

/** Assignment states that no longer occupy the slot. */
export const FREED_STATUSES = new Set(["withdrawn", "not_selected", "declined"]);

export class ReselectError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ReselectResult {
  leadId: string;
  nbfcId: number;
  loanProductId: number;
  nbfcName: string;
  loanProduct: string | null;
  assignmentStatus: "pending";
}

/**
 * Throws `ReselectError` with a dealer-readable message on any rule failure.
 * `dealerCode` must already be verified as the lead's owner by the caller.
 */
export async function reselectFinancing(opts: {
  leadId: string;
  nbfcId: number;
  loanProductId: number;
  dealerCode: string;
}): Promise<ReselectResult> {
  const { leadId, nbfcId, loanProductId, dealerCode } = opts;
  if (!Number.isFinite(nbfcId)) throw new ReselectError("nbfcId required");
  if (!Number.isFinite(loanProductId)) throw new ReselectError("loanProductId required");

  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new ReselectError("Lead not found", 404);
  if (String(lead.payment_method || "").toLowerCase() === "cash") {
    throw new ReselectError("This is a cash lead — there is no lender to route it to.");
  }

  const assignments = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      status: nbfcLeadAssignments.status,
    })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));

  if (assignments.some((a) => a.status === "selected")) {
    throw new ReselectError("A winning lender has already been selected for this lead.");
  }
  if (!assignments.some((a) => FREED_STATUSES.has(a.status))) {
    throw new ReselectError(
      "Another lender can be chosen only after the current one rejects or the deal is closed.",
    );
  }
  if (assignments.some((a) => a.nbfc_id === nbfcId)) {
    throw new ReselectError("This lead has already been routed to that NBFC.");
  }
  const liveCount = assignments.filter((a) => !FREED_STATUSES.has(a.status)).length;
  if (liveCount >= MAX_LIVE_ASSIGNMENTS) {
    throw new ReselectError("This lead is already with a lender. Wait for their decision first.");
  }

  const [dealerRow] = await db
    .select({ id: dealers.id })
    .from(dealers)
    .where(eq(dealers.dealer_id, dealerCode))
    .limit(1);
  if (!dealerRow) throw new ReselectError("Your account is not linked to a dealer.");

  let batteryCategoryName: string | null = null;
  if (lead.product_category_id) {
    const [categoryRow] = await db
      .select({ name: productCategories.name })
      .from(productCategories)
      .where(eq(productCategories.id, lead.product_category_id))
      .limit(1);
    batteryCategoryName = categoryRow?.name ?? null;
  }

  const customer: CustomerProfile = {
    battery_category: batteryCategoryName,
    state: lead.state ?? null,
    city: lead.city ?? null,
    loan_amount: lead.requested_loan_amount ?? null,
    credit_score: null,
    resident_status:
      lead.resident_status === "owned" || lead.resident_status === "rented"
        ? lead.resident_status
        : null,
  };

  const products = await loadActiveProductsForDealer(dealerRow.id);
  const { hits } = matchProducts(customer, products);
  const hit = hits.find((h) => h.product_id === loanProductId && h.nbfc_id === nbfcId);
  if (!hit) {
    throw new ReselectError(
      "That loan product is no longer available for this lead. Refresh the list and pick again.",
    );
  }

  const [nbfcRow] = await db
    .select({ id: nbfc.id, tenant_id: nbfc.tenant_id })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!nbfcRow?.tenant_id) {
    throw new ReselectError("That NBFC is not set up to receive leads. Pick another lender.");
  }
  const tenantId = nbfcRow.tenant_id;

  const [cfg] = await db
    .select()
    .from(nbfcServiceConfig)
    .where(eq(nbfcServiceConfig.tenant_id, tenantId))
    .limit(1);

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(nbfcLeadAssignments)
      .values({
        lead_id: leadId,
        nbfc_id: nbfcId,
        tenant_id: tenantId,
        loan_product_id: loanProductId,
        status: "pending",
        service_config_snapshot: buildServiceSnapshot(cfg, now),
      })
      .onConflictDoNothing({
        target: [nbfcLeadAssignments.lead_id, nbfcLeadAssignments.nbfc_id],
      });

    // MERGE, never replace: the earlier lender stays on the record of what
    // the customer was shown.
    const [row] = await tx
      .select({ id: productSelections.id, selected_nbfcs: productSelections.selected_nbfcs })
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);
    if (row) {
      const existing = Array.isArray(row.selected_nbfcs) ? row.selected_nbfcs : [];
      await tx
        .update(productSelections)
        .set({
          selected_nbfcs: [
            ...existing,
            { nbfc_id: String(nbfcId), loan_product_id: String(loanProductId) },
          ],
          updated_at: now,
        })
        .where(eq(productSelections.id, row.id));
    }

    // A file re-routed after a rejection is back with a lender.
    await tx
      .update(leads)
      .set({ kyc_status: "pending_final_approval", updated_at: now })
      .where(eq(leads.id, leadId));
  });

  const [meta] = await db
    .select({
      name: nbfc.legal_name,
      short: nbfc.short_name,
      product: nbfcLoanProducts.product_name,
    })
    .from(nbfc)
    .leftJoin(nbfcLoanProducts, eq(nbfcLoanProducts.id, loanProductId))
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  const nbfcName = meta?.short || meta?.name || "the lender";

  try {
    await notifyLeadRerouted({
      leadId,
      nbfcTenantId: tenantId,
      nbfcName,
      loanProduct: meta?.product ?? null,
      dealerName: await dealerDisplayName(dealerCode),
    });
  } catch (err) {
    console.error("[reselect-financing] notification failed:", err);
  }

  return {
    leadId,
    nbfcId,
    loanProductId,
    nbfcName,
    loanProduct: meta?.product ?? null,
    assignmentStatus: "pending",
  };
}
