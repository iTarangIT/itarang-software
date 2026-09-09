/**
 * Section G — "which lenders match this customer", without an HTTP request.
 *
 * `GET /api/lead/[id]/section-g-options` answers exactly this, but it answers it
 * for a browser: it needs `requireRole("dealer")` for the dealer_id it then
 * resolves to `dealers.id`, and it wraps the result in Postgres-error
 * translation for a React page. E-264 Phase 2 asks the same question from a
 * WhatsApp turn, where the dealer is known from the lead rather than from a
 * session, so the matching itself is lifted out here.
 *
 * The BRE call and the NBFC grouping are the whole of it — the route keeps its
 * auth and its error shaping, and both callers now group the hits identically.
 * That matters more than it sounds: the grouping is what decides that a lender
 * appears once with N products rather than N times, and the "max 2 NBFCs" cap
 * downstream counts NBFCs, not products.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealers, productCategories } from "@/lib/db/schema";
import {
  loadActiveProductsForDealer,
  matchProducts,
  type CustomerProfile,
} from "@/lib/bre";
import { resolveDefaultProductRules } from "@/lib/leads/city-default-product";

export interface SectionGProduct {
  id: number;
  productName: string;
  loanAmountMin: number;
  loanAmountMax: number;
  tenureMonthsMin: number;
  tenureMonthsMax: number;
  minRoiPct: string;
  maxRoiPct: string;
  downPaymentPct: string;

  // --- The rest of the offer ------------------------------------------------
  // These were computed and then thrown away. `matchProducts` already resolves
  // the fee and insurance columns against the lead's resident_status and hands
  // them back on `hit.bands`; this projection copied seven fields and dropped
  // the three that cost the customer money. A card showing only ROI, tenure and
  // down payment presents two schemes as identical when one carries a ₹2,500
  // processing fee and the other does not.
  //
  // Already resident-status-resolved by the BRE — do NOT re-derive from the
  // owned/rented columns here, or the two surfaces will disagree.
  processingFeeRupees: number | null;
  healthLifeInsuranceRupees: number | null;
  disbursementTatHours: number | null;
  /** Fixed rupee file charge, percentage file charge, or neither. */
  fileChargeFixed: string | null;
  fileChargePct: string | null;
  subventionAvailable: boolean | null;
  /** null = legacy row (unknown); false = bureau check waived. */
  cibilRequired: boolean | null;
  minCreditScore: number | null;
  maxCreditScore: number | null;
}

export interface SectionGNbfc {
  nbfcId: number;
  nbfcCode: string;
  shortName: string;
  legalName: string;
  activeLoanProducts: SectionGProduct[];
}

/** The lead fields the matcher reads. */
export interface SectionGLead {
  dealer_id: string | null;
  product_category_id: string | null;
  state: string | null;
  city: string | null;
  resident_status: string | null;
}

export interface SectionGOptions {
  /**
   * NBFCs this lead may not be offered again — every lender it has ever been
   * assigned to. Applied BEFORE the pinned default is resolved, so a lead
   * whose pinned lender already rejected it falls through to the next rule, or
   * back to the other matches, instead of dead-ending on the Bajaj card.
   */
  excludeNbfcIds?: number[];
}

/**
 * Match a lead against the loan products its dealer may offer.
 *
 * Returns [] rather than throwing when the dealer cannot be resolved or has no
 * candidate products — "no lender matched" is a real, expected answer here
 * (it routes the lead to Manual Handoff), not an error condition.
 *
 * `loanAmount` is optional: omitted, the amount-band rule is skipped so an
 * indicative list can be shown before any price exists. Since the Step-4/Step-5
 * split there is usually no price at this point, which is why it is optional.
 */
export async function loadSectionGOptions(
  lead: SectionGLead,
  loanAmount?: number | null,
  opts?: SectionGOptions,
): Promise<SectionGNbfc[]> {
  if (!lead.dealer_id) return [];

  const [dealerRow] = await db
    .select({ id: dealers.id })
    .from(dealers)
    .where(eq(dealers.dealer_id, lead.dealer_id))
    .limit(1);
  if (!dealerRow) return [];

  const products = await loadActiveProductsForDealer(dealerRow.id);
  if (products.length === 0) return [];

  // Resolve the lead's product_category_id (UUID FK) to its category name
  // (e.g. "3W", "2W") — that's what nbfc_loan_products.eligible_battery_categories
  // stores. The admin NBFC product form picks "3W"/"2W"/etc. so the matcher
  // must compare against the same string, not the lead's UUID.
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
    loan_amount: loanAmount ?? null,
    // Pre-bureau-check at this point in the flow; the rule is skipped unless a
    // score is plumbed in by a later phase.
    credit_score: null,
    resident_status:
      lead.resident_status === "owned" || lead.resident_status === "rented"
        ? lead.resident_status
        : null,
  };

  const result = matchProducts(customer, products);
  const productIndex = new Map(products.map((p) => [p.id, p]));

  const byNbfc = new Map<number, SectionGNbfc>();
  for (const hit of result.hits) {
    const meta = productIndex.get(hit.product_id);
    if (!meta) continue;
    const group = byNbfc.get(hit.nbfc_id) ?? {
      nbfcId: hit.nbfc_id,
      nbfcCode: meta.nbfc_id_code,
      shortName: meta.nbfc_short_name,
      legalName: meta.nbfc_legal_name,
      activeLoanProducts: [],
    };
    group.activeLoanProducts.push({
      id: hit.product_id,
      productName: hit.product_name,
      loanAmountMin: hit.bands.loan_amount_min,
      loanAmountMax: hit.bands.loan_amount_max,
      tenureMonthsMin: hit.bands.tenure_months_min,
      tenureMonthsMax: hit.bands.tenure_months_max,
      minRoiPct: hit.bands.min_roi_pct,
      maxRoiPct: hit.bands.max_roi_pct,
      downPaymentPct: hit.bands.down_payment_pct,
      // From the bands, NOT from `meta` — the BRE has already picked the
      // owned-vs-rented column using the lead's resident_status.
      processingFeeRupees: hit.bands.processing_fee_rupees,
      healthLifeInsuranceRupees: hit.bands.health_life_insurance_rupees,
      disbursementTatHours: hit.bands.disbursement_tat_hours,
      // Not part of any matching rule, so these come off the loaded row.
      fileChargeFixed: meta.file_charge_fixed ?? null,
      fileChargePct: meta.file_charge_pct ?? null,
      subventionAvailable: meta.subvention_available ?? null,
      cibilRequired: meta.cibil_required,
      minCreditScore: meta.min_credit_score,
      maxCreditScore: meta.max_credit_score,
    });
    byNbfc.set(hit.nbfc_id, group);
  }

  let grouped = Array.from(byNbfc.values());

  // Lenders this lead can never be offered again (already assigned, in any
  // status). Filtered here rather than by the caller so the narrowing below
  // sees only what is actually offerable.
  const excluded = opts?.excludeNbfcIds;
  if (excluded && excluded.length > 0) {
    const drop = new Set(excluded);
    grouped = grouped.filter((g) => !drop.has(g.nbfcId));
  }

  return await applyPinnedDefault(lead, grouped);
}

/**
 * E-282/E-283/E-286/E-290/E-291 — narrow the matched list to the lender an
 * admin pinned for this dealer, or for WHERE THIS CUSTOMER LIVES.
 *
 * Applied to the HITS, never in place of them. A pinned product is offered only
 * if it independently matched every BRE rule, so one whose `loan_amount_max`
 * sits below the requested amount, whose battery category does not apply, that
 * has been deactivated, whose NBFC is blocked for this dealer, or that this
 * lead has already been assigned to, is simply absent from `grouped`.
 *
 * `lead.dealer_id` is the dealer CODE (accounts.id), which is exactly what
 * `city_default_loan_products.dealer_code` stores — no resolution needed here.
 * `lead.state` / `lead.city` are the customer's own, the same pair the
 * `active_locations` rule above matched on.
 *
 * Rules arrive most-specific first (dealer, then city, then state) and the
 * FIRST one that survived the BRE wins. A rule that did not fit is skipped
 * rather than abandoning the pin, so a dealer-specific rule that is out of
 * amount band falls through to the city rule instead of dumping the customer
 * onto the full list. Only when no rule fits is the full matched list returned.
 *
 * With nothing configured this is the identity function, which is what keeps
 * every un-pinned dealer and city behaving exactly as it did before E-282.
 */
async function applyPinnedDefault(
  lead: SectionGLead,
  grouped: SectionGNbfc[],
): Promise<SectionGNbfc[]> {
  if (grouped.length === 0) return grouped;

  // One location leg, and it is the CUSTOMER's (E-291). This does not widen
  // coverage: the BRE's `active_locations` rule above has already dropped every
  // lender that cannot serve this lead, so a pin only ever chooses among the
  // lenders that can — a rule naming a city no lender covers simply finds
  // nothing in `grouped` and falls through.
  const rules = await resolveDefaultProductRules({
    dealerCode: lead.dealer_id,
    customerState: lead.state,
    customerCity: lead.city,
  });

  for (const rule of rules) {
    const group = grouped.find((g) => g.nbfcId === rule.nbfcId);
    const product = group?.activeLoanProducts.find(
      (p) => p.id === rule.loanProductId,
    );
    if (!group || !product) continue;

    // Exclusive: one lender, and only the pinned product of it.
    return [{ ...group, activeLoanProducts: [product] }];
  }

  return grouped;
}
