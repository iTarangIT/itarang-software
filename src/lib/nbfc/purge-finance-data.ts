/**
 * Finance-data purge — BRD Addendum V0.2 §12.3.
 *
 * Invoked when a finance lead reaches a terminal dead-end (admin-confirmed
 * "Financing Unavailable") or is converted to a cash sale. Purges the
 * finance-only sensitive data while RETAINING the minimal audit record the
 * addendum mandates.
 *
 * PURGED:
 *   - Equifax / bureau report + score   → kyc_verifications bureau cards
 *                                          (api_request/api_response/match_score nulled)
 *   - Co-borrower KYC data & documents  → co_borrowers, co_borrower_documents,
 *                                          co_borrower_requests rows deleted
 *   - NBFC financing terms              → nbfc_financing_offers rows deleted
 *   - Finance scoring / draft blob      → leads.kyc_score, leads.kyc_draft_data nulled
 *
 * RETAINED (NOT touched here): lead id, customer name/contact, "financing
 * attempted", the category-level decline reason (leads.financing_decline_category),
 * which NBFCs declined (nbfc_lead_assignments rows + their statuses), who
 * converted/closed, and timestamps. A purge audit record is written.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLogs,
  coBorrowerDocuments,
  coBorrowerRequests,
  coBorrowers,
  kycVerifications,
  leads,
  nbfcFinancingOffers,
} from "@/lib/db/schema";

export interface PurgeFinanceDataArgs {
  leadId: string;
  performedBy?: string | null;
  /** Why the purge ran — 'dead_end' (Financing Unavailable) or 'cash_conversion'. */
  reason: "dead_end" | "cash_conversion";
}

export async function purgeFinanceData(args: PurgeFinanceDataArgs): Promise<{
  coBorrowers: number;
  coBorrowerDocuments: number;
  financingOffers: number;
  bureauCards: number;
}> {
  const { leadId } = args;
  const counts = { coBorrowers: 0, coBorrowerDocuments: 0, financingOffers: 0, bureauCards: 0 };

  await db.transaction(async (tx) => {
    // Co-borrower KYC documents & data (delete docs first — FK-free but tidy).
    const docs = await tx
      .delete(coBorrowerDocuments)
      .where(eq(coBorrowerDocuments.lead_id, leadId))
      .returning({ id: coBorrowerDocuments.id });
    counts.coBorrowerDocuments = docs.length;

    const cob = await tx
      .delete(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .returning({ id: coBorrowers.id });
    counts.coBorrowers = cob.length;

    await tx.delete(coBorrowerRequests).where(eq(coBorrowerRequests.lead_id, leadId));

    // NBFC financing terms (commercial offers).
    const offers = await tx
      .delete(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.lead_id, leadId))
      .returning({ id: nbfcFinancingOffers.id });
    counts.financingOffers = offers.length;

    // Bureau report/score — null the raw payloads on the credit-bureau KYC
    // cards (keep the row skeleton so "a bureau check happened" stays auditable,
    // but the Equifax report and score themselves are gone).
    const cleared = await tx
      .update(kycVerifications)
      .set({ api_request: null, api_response: null, match_score: null, updated_at: new Date() })
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          sql`${kycVerifications.verification_type} ILIKE ANY (ARRAY['%cibil%','%credit%','%bureau%','%equifax%'])`,
        ),
      )
      .returning({ id: kycVerifications.id });
    counts.bureauCards = cleared.length;

    // Finance scoring + draft blob on the lead.
    await tx
      .update(leads)
      .set({ kyc_score: null, kyc_draft_data: null, updated_at: new Date() })
      .where(eq(leads.id, leadId));

    await tx.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "lead",
      entity_id: leadId,
      action: "lead.finance_data_purged",
      performed_by: args.performedBy ?? null,
      new_data: { reason: args.reason, purged: counts, purged_at: new Date().toISOString() },
    });
  });

  return counts;
}
