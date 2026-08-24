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
    });
    byNbfc.set(hit.nbfc_id, group);
  }

  return Array.from(byNbfc.values());
}
