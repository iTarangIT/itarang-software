/**
 * The firm financing offers on a lead — read, lifted out of the dealer route.
 *
 * WHY THIS EXISTS.
 *
 * `GET /api/lead/[id]/offers` was the only reader, and everything below its auth
 * check is channel-agnostic. The WhatsApp offer phase has to show the customer
 * the same offers, and a chat turn has no Supabase session to hand
 * `requireRole("dealer")`. Same split as `submit-step4.ts`: the route decides
 * *who may look*, this decides *what they see*.
 *
 * THE ONE RULE THIS FILE EXISTS TO CENTRALISE (E-161). An out-of-band offer held
 * for iTarang CEO approval must never reach a borrower. Re-deriving that filter
 * at a second call site is how a held deviation ends up on someone's phone —
 * which is the worst failure mode in the whole offer flow. It is applied once,
 * here, and both callers inherit it.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  nbfc,
  nbfcFinancingOffers,
  nbfcLeadAssignments,
} from "@/lib/db/schema";
import { listRoundsForOffers } from "@/lib/nbfc/offer-negotiation";

type OfferRow = typeof nbfcFinancingOffers.$inferSelect;
type RoundRow = Awaited<ReturnType<typeof listRoundsForOffers>>[number];

/** True when an offer row has been released to the borrower side (E-161). */
export function isOfferReleased(o: {
  ceo_approval_status: string | null;
}): boolean {
  return (
    o.ceo_approval_status === "not_required" || o.ceo_approval_status === "approved"
  );
}

export interface LeadOfferItem {
  nbfc_id: number;
  nbfc_id_code: string | null;
  nbfc_short_name: string | null;
  nbfc_legal_name: string | null;
  /** The `nbfc_lead_assignments.status` for this lender. */
  status: string;
  /** NULL until this lender submits, or while E-161 withholds a revision. */
  offer: OfferRow | null;
  negotiation_status: string | null;
  negotiation_round: number;
  fixed_at: Date | null;
  negotiation: RoundRow[];
  /**
   * The lender HAS submitted something the E-161 filter withheld — distinct from
   * `offer === null`, which means nothing was submitted at all. 'pending' waits
   * on iTarang; 'rejected' waits on the lender to re-price within band.
   */
  withheld_reason: string | null;
}

export interface LeadOffersView {
  leadId: string;
  kycStatus: string | null;
  winnerNbfcId: number | null;
  items: LeadOfferItem[];
}

/**
 * Every routed lender on a lead with its released offer and negotiation thread.
 *
 * The caller owns authorisation. Returns an empty `items` array for a lead with
 * no routed lenders rather than throwing — "nobody has offered yet" is a normal
 * state, not an error.
 */
export async function listLeadOffers(leadId: string): Promise<LeadOffersView> {
  const [lead] = await db
    .select({ id: leads.id, kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) throw new Error("NOT_FOUND: lead not found");

  const assignments = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      status: nbfcLeadAssignments.status,
    })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));

  const nbfcIds = assignments.map((a) => a.nbfc_id);
  const nbfcRows = nbfcIds.length
    ? await db
        .select({
          id: nbfc.id,
          nbfc_id_code: nbfc.nbfc_id,
          short_name: nbfc.short_name,
          legal_name: nbfc.legal_name,
        })
        .from(nbfc)
        .where(inArray(nbfc.id, nbfcIds))
    : [];
  const nameById = new Map(nbfcRows.map((r) => [r.id, r] as const));

  // Scoped by lead_id as well as nbfc_id. Matching on nbfc_id alone pulled in
  // that NBFC's offers on OTHER leads too — harmless for the offer lookup,
  // which re-keys by this lead's assignment ids, but E-238 reads negotiation
  // rounds off these rows and would otherwise fetch other leads' threads.
  const offerRows = nbfcIds.length
    ? await db
        .select()
        .from(nbfcFinancingOffers)
        .where(
          and(
            eq(nbfcFinancingOffers.lead_id, leadId),
            inArray(nbfcFinancingOffers.nbfc_id, nbfcIds),
          ),
        )
    : [];
  const released = offerRows.filter(isOfferReleased);
  const offerByAssignment = new Map(released.map((o) => [o.assignment_id, o] as const));
  // Every offer row, released or not. Used only to tell a withheld revision
  // apart from "nothing submitted yet" — see withheld_reason.
  const anyOfferByAssignment = new Map(
    offerRows.map((o) => [o.assignment_id, o] as const),
  );

  // E-238 — the negotiation history. Read off ALL offer rows, not just the
  // released ones: mid-negotiation a revision can go out of band and get held by
  // E-161, and the borrower should not watch the thread they were part of
  // disappear while that sits with the iTarang CEO. This leaks nothing, because
  // a round is only ever written once its terms were released.
  const roundRows = await listRoundsForOffers(
    db,
    offerRows.map((o) => o.id),
  );
  const roundsByOffer = new Map<string, RoundRow[]>();
  for (const r of roundRows) {
    const list = roundsByOffer.get(r.offer_id);
    if (list) list.push(r);
    else roundsByOffer.set(r.offer_id, [r]);
  }

  const items: LeadOfferItem[] = assignments.map((a) => {
    const offer = offerByAssignment.get(a.id) ?? null;
    const anyOffer = anyOfferByAssignment.get(a.id) ?? null;
    return {
      nbfc_id: a.nbfc_id,
      nbfc_id_code: nameById.get(a.nbfc_id)?.nbfc_id_code ?? null,
      nbfc_short_name: nameById.get(a.nbfc_id)?.short_name ?? null,
      nbfc_legal_name: nameById.get(a.nbfc_id)?.legal_name ?? null,
      status: a.status,
      offer,
      negotiation_status: offer?.negotiation_status ?? null,
      negotiation_round: offer?.negotiation_round ?? 0,
      fixed_at: offer?.fixed_at ?? null,
      negotiation: anyOffer ? (roundsByOffer.get(anyOffer.id) ?? []) : [],
      withheld_reason:
        anyOffer != null && offer == null ? (anyOffer.ceo_approval_status ?? null) : null,
    };
  });

  const winner = assignments.find((a) => a.status === "selected") ?? null;

  return {
    leadId,
    kycStatus: lead.kyc_status,
    winnerNbfcId: winner?.nbfc_id ?? null,
    items,
  };
}

/**
 * The offers a borrower can still act on: released, not yet decided, and not
 * withdrawn. Used by the chat flow, which has room for choices but not for the
 * "nothing submitted yet" placeholders the portal renders.
 */
export function actionableOffers(view: LeadOffersView): LeadOfferItem[] {
  return view.items.filter(
    (i) => i.offer != null && i.status !== "withdrawn" && i.status !== "not_selected",
  );
}
