/**
 * Refinancing a recovered battery — BRD §13, §14.
 *
 * THE GAP THIS FILLS
 *   `auction_type = 'cash_refinance'` has been a LABEL and nothing else. It is
 *   set on the lot, filtered on in the dealer API, rendered on the card, in the
 *   detail page and in the published-lot email — and nowhere in the codebase
 *   does anything create a loan from it. A dealer could win a "cash + refinance"
 *   lot and discover there was no financing behind the words.
 *
 *   For the lender this is the point of the whole module: a recovered asset is
 *   financed again and redeployed, rather than liquidated once.
 *
 * ⚠ ASSUMPTION THE BUSINESS MUST CONFIRM
 *   The refinanced loan is raised with the SELLING NBFC — the tenant that owned
 *   the battery and ran the auction. The alternative reading is that it should
 *   be routed competitively like a new origination, which would put it through
 *   the Acquire workspace and a different lender might win it. That decision
 *   changes who carries the asset and it has not been made. This module takes
 *   the simpler reading, records it here, and is a single function to change if
 *   the answer is the other one.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not call `projectDisbursedLoan()`. That is the DISBURSEMENT path —
 *   it creates `nbfc_loans` and a full EMI ledger. Money has not moved at the
 *   moment a sanction is raised, and fabricating a repayment schedule for a
 *   disbursement that has not happened would put fictional rows into the
 *   servicing views, the DPD calculation and the collections queue. The sanction
 *   is raised; disbursement stays where it already lives.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  auctionSettlements,
  auctionLots,
  loanSanctions,
  nbfcAuditLog,
} from "@/lib/db/schema";
import { refinanceSplit } from "@/lib/auction/refinance-split";

// The split itself is pure arithmetic and lives in its own module with no
// database import, so the dealer's bidding screen can show the same figures
// BEFORE a bid is placed that the sanction is raised from afterwards.
export {
  refinanceSplit,
  REFINANCE_DOWN_PAYMENT_PCT,
  type RefinanceSplit,
} from "@/lib/auction/refinance-split";

export interface CreateRefinanceInput {
  settlement_id: string;
  actor_tenant_id: string;
  actor_user_id: string;
}

export interface CreateRefinanceResult {
  settlement_id: string;
  loan_sanction_id: string;
  financed: number;
  cash_due: number;
  already_existed: boolean;
}

/**
 * Raises the sanction behind a `cash_refinance` win.
 *
 * Idempotent: a settlement that already carries a `refinance_loan_id` returns
 * it rather than raising a second loan against the same battery.
 */
export async function createRefinanceSanction(
  input: CreateRefinanceInput,
): Promise<CreateRefinanceResult> {
  const [row] = await db
    .select({
      id: auctionSettlements.id,
      lot_id: auctionSettlements.lot_id,
      seller_tenant_id: auctionSettlements.seller_tenant_id,
      winner_dealer_id: auctionSettlements.winner_dealer_id,
      final_price: auctionSettlements.final_price,
      refinance_loan_id: auctionSettlements.refinance_loan_id,
      auction_type: auctionLots.auction_type,
      lot_code: auctionLots.lot_code,
    })
    .from(auctionSettlements)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionSettlements.lot_id))
    .where(
      and(
        eq(auctionSettlements.id, input.settlement_id),
        eq(auctionSettlements.seller_tenant_id, input.actor_tenant_id),
      ),
    )
    .limit(1);

  if (!row) throw new Error("NOT_FOUND: settlement not found for this NBFC");

  const split = refinanceSplit(Number(row.final_price));

  if (row.refinance_loan_id) {
    return {
      settlement_id: row.id,
      loan_sanction_id: row.refinance_loan_id,
      financed: split.financed,
      cash_due: split.cash_due,
      already_existed: true,
    };
  }

  if (row.auction_type !== "cash_refinance") {
    throw new Error(
      "CONFLICT: this lot was sold for cash — there is nothing to finance",
    );
  }
  if (!row.winner_dealer_id) {
    throw new Error(
      "CONFLICT: the winner is not a dealer, so there is nobody to raise a loan against",
    );
  }
  if (!(split.financed > 0)) {
    throw new Error("CONFLICT: the financed portion is zero");
  }

  const loanId = `LS-AUC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(loanSanctions).values({
      id: loanId,
      // No lead: this borrower is a DEALER buying stock, not a retail customer
      // being sold a vehicle. The origination path that normally fills lead_id
      // has no row here, and inventing one would put a fake customer into the
      // leads pipeline.
      lead_id: null,
      product_selection_id: null,
      nbfc_id: row.seller_tenant_id,
      loan_amount: String(split.financed),
      down_payment: String(split.cash_due),
      file_charge: "0",
      subvention: "0",
      disbursement_amount: String(split.financed),
      emi: String(split.indicative_emi),
      tenure_months: split.tenure_months,
      roi: String(split.roi),
      loan_approved_by: "auction",
      loan_file_number: row.lot_code,
      status: "sanctioned",
      sanctioned_by: input.actor_user_id,
      sanctioned_at: now,
      created_at: now,
      updated_at: now,
    });

    await tx
      .update(auctionSettlements)
      .set({ refinance_loan_id: loanId, updated_at: now })
      .where(eq(auctionSettlements.id, row.id));

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.actor_tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_refinance_sanctioned",
      action_id: row.id,
      before_state: { refinance_loan_id: null },
      after_state: {
        loan_sanction_id: loanId,
        lot_code: row.lot_code,
        dealer_id: row.winner_dealer_id,
        total: split.total,
        cash_due: split.cash_due,
        financed: split.financed,
        // Recorded on the row itself, so anyone auditing this later can see
        // which reading of the routing question it was raised under.
        assumption: "loan sits with the selling NBFC, not competitively routed",
      },
      created_at: now,
    });
  });

  return {
    settlement_id: row.id,
    loan_sanction_id: loanId,
    financed: split.financed,
    cash_due: split.cash_due,
    already_existed: false,
  };
}
