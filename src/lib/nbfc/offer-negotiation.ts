/**
 * Dealer <-> NBFC negotiation over a firm financing offer — E-238.
 *
 * The firm offer (nbfc_financing_offers) is UNIQUE on assignment_id and the
 * submit route upserts it in place, so it only ever holds the CURRENT terms.
 * Every round of the conversation is appended to nbfc_offer_negotiations, and
 * the four negotiation_* / fixed_* columns on the offer carry the current state.
 *
 * THE INVARIANT, enforced by the callers of appendRound():
 *   A round is written only when its terms are visible to the dealer.
 * E-161 holds an out-of-band offer at ceo_approval_status='pending' and
 * GET /api/lead/[id]/offers filters it out; appending a round there would leak
 * unapproved terms into the dealer's history. So the NBFC submit route appends
 * on the same `ceoStatus !== "pending"` condition that already gates the
 * offer_submitted flip, and applyFinancingOfferDeviationApproval appends when
 * the iTarang CEO approves.
 *
 * The vocabulary below is the enforcement point the migration's COMMENTs point
 * at: E-238 deliberately ships no CHECK constraints, per the convention this
 * table family has followed since E-202.
 */
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcOfferNegotiations } from "@/lib/db/schema";

/** Anything that can run a query — the real db, or a transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export const NEGOTIATION_PARTIES = ["nbfc", "dealer"] as const;
export type NegotiationParty = (typeof NEGOTIATION_PARTIES)[number];

export const NEGOTIATION_KINDS = ["offer", "counter", "fix"] as const;
export type NegotiationKind = (typeof NEGOTIATION_KINDS)[number];

export const NEGOTIATION_STATUSES = ["open", "dealer_countered", "fixed"] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

/**
 * The six terms either side can move. Order is the display order used by both
 * portals, and matches the field order of the NBFC's own offer form.
 */
export const NEGOTIABLE_FIELDS = [
  "loan_amount",
  "roi_pct",
  "emi_amount",
  "tenure_months",
  "down_payment",
  "processing_fee",
] as const;
export type NegotiableField = (typeof NEGOTIABLE_FIELDS)[number];

export const FIELD_LABEL: Record<NegotiableField, string> = {
  loan_amount: "Loan amount",
  roi_pct: "ROI",
  emi_amount: "EMI",
  tenure_months: "Tenure",
  down_payment: "Down payment",
  processing_fee: "Processing fee",
};

/**
 * A round's terms. Kept as strings because numeric(14,2) round-trips through
 * the driver as a string, and comparing "16.00" to 16 is exactly the kind of
 * mistake that makes a diff render a field as changed when it isn't.
 */
export type RoundTerms = {
  loan_amount: string | null;
  roi_pct: string | null;
  emi_amount: string | null;
  tenure_months: number | null;
  down_payment: string | null;
  processing_fee: string | null;
};

/** Runaway-thread backstop. A real negotiation is 2-4 rounds; 20 is not one. */
export const MAX_NEGOTIATION_ROUNDS = 20;

/** Message cap, mirrored by the Zod schemas in both write routes. */
export const MAX_MESSAGE_LENGTH = 2000;

const numStr = (v: number | string | null | undefined): string | null =>
  v == null || v === "" ? null : String(v);

/**
 * Numeric-safe equality for a negotiated term. "16.00" and "16" are the same
 * ask; a string compare would call them different and show a phantom diff.
 */
export function sameTerm(a: string | number | null, b: string | number | null): boolean {
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a) === String(b);
  return na === nb;
}

/** The fields on which `next` differs from `prev`. Drives the UI diff. */
export function changedFields(
  prev: Partial<RoundTerms> | null,
  next: Partial<RoundTerms>,
): NegotiableField[] {
  if (!prev) return [];
  return NEGOTIABLE_FIELDS.filter(
    (f) => next[f] !== undefined && !sameTerm(prev[f] ?? null, next[f] ?? null),
  );
}

/**
 * Append one round.
 *
 * `round` is computed as negotiation_round + 1 by the caller and guarded by the
 * UNIQUE index on (offer_id, round): if two writers race, the loser gets 23505
 * rather than a second row claiming the same round. Callers must run this
 * inside the same transaction as the offer's negotiation_round bump so the
 * counter and the log cannot disagree.
 */
export async function appendRound(
  tx: Executor,
  input: {
    offer_id: string;
    assignment_id: string;
    lead_id: string;
    nbfc_id: number;
    tenant_id: string;
    round: number;
    party: NegotiationParty;
    kind: NegotiationKind;
    terms: Partial<RoundTerms>;
    conditions?: string | null;
    message?: string | null;
    created_by?: string | null;
    created_at?: Date;
  },
): Promise<void> {
  await tx.insert(nbfcOfferNegotiations).values({
    offer_id: input.offer_id,
    assignment_id: input.assignment_id,
    lead_id: input.lead_id,
    nbfc_id: input.nbfc_id,
    tenant_id: input.tenant_id,
    round: input.round,
    party: input.party,
    kind: input.kind,
    loan_amount: numStr(input.terms.loan_amount),
    roi_pct: numStr(input.terms.roi_pct),
    emi_amount: numStr(input.terms.emi_amount),
    tenure_months:
      input.terms.tenure_months == null ? null : Number(input.terms.tenure_months),
    down_payment: numStr(input.terms.down_payment),
    processing_fee: numStr(input.terms.processing_fee),
    conditions: input.conditions ?? null,
    message: input.message ?? null,
    created_by: input.created_by ?? null,
    ...(input.created_at ? { created_at: input.created_at } : {}),
  });
}

/**
 * Seed round 1 from the NBFC's current offer terms when a thread is empty.
 *
 * Offers submitted before E-238 have negotiation_round = 0 and no rows here, so
 * the dealer's first counter would otherwise start the history at "round 2, no
 * idea what round 1 was". Seeding lazily on first use is what lets this
 * migration ship with no data backfill. Returns the round number now occupied.
 */
export async function seedOpeningRoundIfMissing(
  tx: Executor,
  offer: {
    id: string;
    assignment_id: string;
    lead_id: string;
    nbfc_id: number;
    tenant_id: string;
    negotiation_round: number;
    submitted_by: string | null;
    submitted_at: Date | null;
    conditions: string | null;
  } & RoundTerms,
): Promise<number> {
  if (offer.negotiation_round > 0) return offer.negotiation_round;

  await appendRound(tx, {
    offer_id: offer.id,
    assignment_id: offer.assignment_id,
    lead_id: offer.lead_id,
    nbfc_id: offer.nbfc_id,
    tenant_id: offer.tenant_id,
    round: 1,
    party: "nbfc",
    kind: "offer",
    terms: offer,
    conditions: offer.conditions,
    created_by: offer.submitted_by,
    // Backdate to when the offer was actually submitted — the round is a record
    // of that moment, not of the moment we got around to writing it down.
    created_at: offer.submitted_at ?? undefined,
  });
  return 1;
}

/** Every round for an offer, oldest first. */
export async function listRounds(tx: Executor, offerId: string) {
  return tx
    .select()
    .from(nbfcOfferNegotiations)
    .where(eq(nbfcOfferNegotiations.offer_id, offerId))
    .orderBy(asc(nbfcOfferNegotiations.round));
}

/** Every round across a set of offers (the dealer list / admin view), oldest first. */
export async function listRoundsForOffers(tx: Executor, offerIds: string[]) {
  if (offerIds.length === 0) return [];
  // inArray, never a raw sql`= ANY(array)` — drizzle expands a JS array in a
  // raw template into a row constructor, which fails at runtime.
  return tx
    .select()
    .from(nbfcOfferNegotiations)
    .where(inArray(nbfcOfferNegotiations.offer_id, offerIds))
    .orderBy(asc(nbfcOfferNegotiations.offer_id), asc(nbfcOfferNegotiations.round));
}
