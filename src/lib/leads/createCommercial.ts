// Create a new versioned commercials row (BRD §0.10) — the one writer behind
// POST /api/inside-sales/lead/[id]/commercials AND the WhatsApp Assistant's
// create_quote. Flips prior is_current to false and inserts version_no = max+1
// atomically. A quote_issue/quote_revision runs the E-226 OEM price gate.
//
// The caller has already asserted ownership. Everything that must be atomic
// runs on `opts.tx` (or a fresh transaction); everything after the write —
// the PDF draft, the paired touchpoint, notifications — is returned as
// `afterCommit`, which the caller runs once the transaction has COMMITTED so a
// rendering failure can never undo an approval the rule has already granted.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeadCommercials, dealerLeads } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { advanceLeadOnQuoteEvent } from "@/lib/leads/quoteStatus";
import { initialApprovalStatus, isGatedQuoteEvent } from "@/lib/leads/quoteApproval";
import { tryGenerateQuotationDraft } from "@/lib/leads/quoteDraft";
import {
    notifyQuotationApproved,
    notifyQuotationPendingApproval,
} from "@/lib/notifications/events";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { snapshotListPrices as snapshotListPriceCatalogue } from "@/lib/leads/listPriceCatalogue";
import type { ListPriceSnapshot } from "@/lib/leads/listPricing";
import { loadLiveListPrices, snapshotListPrices } from "@/lib/leads/listPrices";
import {
    evaluateAgainstOemPrices,
    linesNeedingAttention,
    resolveQuoteApproval,
    type OemEvaluation,
} from "@/lib/leads/oemPricing";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import {
    applyTermsHold,
    getStandardQuoteTerms,
    resolveQuoteTerms,
    termsHold,
    type DealerPaymentTerms,
    type QuoteTerms,
    type ResolvedQuoteTerms,
    type TermsHold,
} from "@/lib/leads/quoteTerms";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const COMMERCIAL_EVENT_TYPES = [
    "brochure_share",
    "quote_issue",
    "quote_revision",
    "terms_update",
    "final_terms",
] as const;
export type CommercialEventType = (typeof COMMERCIAL_EVENT_TYPES)[number];

/** A commercial event the lead's quotes do not allow. Carries its HTTP status (withErrorHandler). */
export class CommercialInputError extends Error {
    readonly status: number;
    constructor(message: string, status = 409) {
        super(message);
        this.name = "CommercialInputError";
        this.status = status;
    }
}

export type CommercialInput = {
    event_type: CommercialEventType;
    price_quoted?: number | null;
    quote_document_url?: string | null;
    brochure_url?: string | null;
    /**
     * E-322 (ID 73): the structured terms. Required on a quote issue /
     * revision. Terms events take the payment terms of the quote they follow
     * (only customer_finance may change there). Warranty and delivery are
     * never taken from the caller — they are the admin's standard terms.
     */
    terms?: QuoteTerms | null;
    /** @deprecated ignored since E-322 — derived from `terms`. */
    credit_terms?: string | null;
    /** @deprecated ignored since E-322 — standard terms from settings. */
    delivery_terms?: string | null;
    /** @deprecated ignored since E-322 — standard terms from settings. */
    warranty_terms?: string | null;
    final_price?: number | null;
    /** @deprecated ignored since E-322 — mirrored from terms.customer_finance. */
    payment_method?: "cash" | "finance" | null;
    deal_notes?: string | null;
    product_lines?: CommercialsProductLine[];
    notes?: string | null;
};

export type CreateCommercialArgs = {
    leadId: string;
    actor: { id: string; name: string | null };
    body: CommercialInput;
    /** Defaults to now — the instant the quote is stamped and judged. */
    performedAt?: Date;
};

export type CreateCommercialResult = {
    commercialId: string | null;
    versionNo: number;
    approvalStatus: string;
    autoApproved: boolean;
    evaluation: OemEvaluation | null;
    /** E-322: set when the quote waits because of credit terms. */
    termsHold: TermsHold | null;
    /** Draft PDF, touchpoint, notifications. Run after COMMIT. Never throws past a draft failure. */
    afterCommit: () => Promise<{ quote_number: string | null }>;
};

export async function createLeadCommercial(
    args: CreateCommercialArgs,
    opts?: { tx?: Tx },
): Promise<CreateCommercialResult> {
    const { leadId: id, actor, body } = args;
    const performedAt = args.performedAt ?? new Date();

    const write = async (tx: Tx) => {
        const maxRows = await tx.execute<{ max_v: number | null }>(sql`
            SELECT MAX(version_no) AS max_v FROM dealer_lead_commercials WHERE dealer_lead_id = ${id}
        `);
        const nextVersion = Number(maxRows[0]?.max_v ?? 0) + 1;

        // E-226 — the gate is price-aware. A quote whose every line is at or
        // above its OEM reference price releases immediately; one line below
        // reference, one the rep left unpriced, or one product with no
        // reference on file still waits for the CEO.
        //
        // Read inside this transaction so the prices judged against are the
        // ones live at the instant the quote is written — a revision landing
        // mid-request cannot half-apply.
        let approvalStatus: string = initialApprovalStatus(body.event_type);
        let approvalMode: string | null = null;
        let oemEvaluation: OemEvaluation | null = null;
        // E-323: the list price each line is quoted against, frozen with the quote.
        let listPriceSnapshot: ListPriceSnapshot | null = null;
        let hold: TermsHold | null = null;

        // ── E-322 terms (ID 73) ──
        // Brochures carry no terms. Quotes must state payment terms; terms
        // events inherit them from the quote they follow (below), so moving a
        // deal onto credit always goes through a quote revision — the gated
        // event — and can never slip past approval as a "terms update".
        const standard =
            body.event_type === "brochure_share" ? null : await getStandardQuoteTerms(tx);
        let terms: ResolvedQuoteTerms | null = null;
        if (isGatedQuoteEvent(body.event_type)) {
            if (!body.terms) {
                throw new CommercialInputError(
                    "Choose the dealer payment terms (Cash or Credit with days) for this quote.",
                    400,
                );
            }
            terms = resolveQuoteTerms(body.terms, standard!);
            hold = termsHold(terms);
        }
        // ── end E-322 ──
        // E-321 — gated quote lines with their printed list price snapshotted.
        // null = not a gated event; the lines are written as sent (terms events
        // carry over the quote's already-snapshotted lines below).
        let snapshottedLines: CommercialsProductLine[] | null = null;

        if (isGatedQuoteEvent(body.event_type)) {
            const lines = body.product_lines ?? [];
            // performedAt, not now(): E-230 resolves the price by its validity
            // window, so the quote must be judged against the price in force at
            // the instant the quote is stamped.
            const refs = await loadLiveOemPrices(lines, tx, performedAt);
            oemEvaluation = evaluateAgainstOemPrices(lines, refs, performedAt);
            // E-323: the list price each line is quoted against, frozen with the quote
            // (list_price_snapshot — read by the data exports and quoteDraft).
            listPriceSnapshot = await snapshotListPriceCatalogue(lines, tx, performedAt);
            // E-322: credit terms hold the quote for approval even when every
            // line clears the price check. Recorded on the evaluation so the
            // CEO panel can say why it is waiting.
            const resolved = applyTermsHold(resolveQuoteApproval(oemEvaluation), hold);
            approvalStatus = resolved.status;
            approvalMode = resolved.mode;
            oemEvaluation = { ...oemEvaluation, terms_hold: hold };

            // ── E-321 list price snapshot (display only, approval untouched) ──
            // Live list price at performedAt, else the live OEM price, else
            // null. Frozen on the row so a later list-price change never
            // alters a quote's document.
            const listRefs = await loadLiveListPrices(lines, tx, performedAt);
            snapshottedLines = snapshotListPrices(lines, listRefs, refs);
            // ── end E-321 ──
        }

        // ID 61: terms rows carry no price of their own. A price change is a
        // new quote revision through the approval gate; final terms take the
        // dealer-approved quote's price, terms updates the latest quote's.
        // Whatever price the caller sent for these events is ignored.
        let price = {
            price_quoted: body.price_quoted ?? null,
            final_price: body.final_price ?? null,
            product_lines: snapshottedLines ?? body.product_lines ?? [],
        };
        if (body.event_type === "final_terms" || body.event_type === "terms_update") {
            const source = await tx.execute<{
                price_quoted: string | null;
                final_price: string | null;
                product_lines: CommercialsProductLine[] | null;
                dealer_payment_terms: string | null;
                credit_days: number | null;
                customer_finance: boolean | null;
            }>(sql`
                SELECT price_quoted::text AS price_quoted,
                       final_price::text AS final_price,
                       product_lines,
                       dealer_payment_terms, credit_days, customer_finance
                  FROM dealer_lead_commercials
                 WHERE dealer_lead_id = ${id}
                   AND event_type IN ('quote_issue', 'quote_revision')
                   AND withdrawn_at IS NULL
                   -- A quote the CEO rejected is not a price anyone agreed to.
                   AND approval_status IS DISTINCT FROM 'rejected'
                   ${body.event_type === "final_terms" ? sql`AND dealer_decision = 'approved'` : sql``}
                 ORDER BY version_no DESC
                 LIMIT 1
            `);
            const q = source[0];
            // ID 61: final terms ARE the dealer-approved quote's terms. With no
            // such quote there is no final price to record — the row would be
            // saved priceless and become the lead's current commercial.
            if (!q && body.event_type === "final_terms") {
                throw new CommercialInputError(
                    "Final terms need a quote the dealer has approved. Send the quote and record the dealer's " +
                        "approval first, or save a Terms update instead.",
                );
            }
            price = {
                price_quoted: q?.price_quoted != null ? Number(q.price_quoted) : null,
                final_price: q?.final_price != null ? Number(q.final_price) : null,
                product_lines: q?.product_lines ?? [],
            };
            // E-322: payment terms come from the quote; customer finance may
            // be updated here (it feeds onboarding, not approval). A pre-E-322
            // quote has no structured terms — those rows read as Cash.
            const quoteTerms: DealerPaymentTerms =
                q?.dealer_payment_terms === "credit" ? "credit" : "cash";
            terms = resolveQuoteTerms(
                {
                    dealer_payment_terms: quoteTerms,
                    credit_days: quoteTerms === "credit" ? (q?.credit_days ?? null) : null,
                    customer_finance:
                        body.terms?.customer_finance ?? q?.customer_finance ?? null,
                },
                standard!,
            );
        }

        await tx.execute(sql`
            UPDATE dealer_lead_commercials
            SET is_current = false, updated_at = NOW()
            WHERE dealer_lead_id = ${id} AND is_current = true
        `);

        const inserted = await tx
            .insert(dealerLeadCommercials)
            .values({
                dealer_lead_id: id,
                version_no: nextVersion,
                is_current: true,
                event_type: body.event_type,
                price_quoted: price.price_quoted != null ? String(price.price_quoted) : null,
                quote_document_url: body.quote_document_url ?? null,
                brochure_url: body.brochure_url ?? null,
                brochure_sent_at: body.event_type === "brochure_share" ? performedAt : null,
                // E-322: all terms from `terms` (structured, standard
                // warranty / delivery); never the caller's free text.
                credit_terms: terms?.credit_terms ?? null,
                delivery_terms: terms?.delivery_terms ?? null,
                warranty_terms: terms?.warranty_terms ?? null,
                final_price: price.final_price != null ? String(price.final_price) : null,
                payment_method: terms?.payment_method ?? null,
                dealer_payment_terms: terms?.dealer_payment_terms ?? null,
                credit_days: terms?.credit_days ?? null,
                customer_finance: terms?.customer_finance ?? null,
                deal_notes: body.deal_notes ?? null,
                product_lines: price.product_lines,
                notes: body.notes ?? null,
                created_by: actor.id,
                // E-221 + E-226 — a gated quote lands 'pending' unless the OEM
                // price check clears every line, in which case it is born
                // 'approved'. Every other event type is born approved as
                // before. The row is is_current either way, so the rep sees
                // their quote on the lead immediately; a pending one carries
                // the badge and must not go to the dealer.
                approval_status: approvalStatus,
                approval_mode: approvalMode,
                oem_evaluation: oemEvaluation,
                list_price_snapshot: listPriceSnapshot,
                // Auto-approval stamps the time but leaves approved_by NULL: no
                // human approved this, and NULL says so exactly. A 'system'
                // sentinel would be a non-uuid string in the column the CEO
                // queue joins to users.
                approved_at: approvalMode === "auto" ? performedAt : null,
            })
            .returning({ commercial_id: dealerLeadCommercials.commercial_id });

        // BRD §0.10: dealer_leads.brochure_sent_at = first brochure_share ever; never overwritten.
        if (body.event_type === "brochure_share") {
            // ISO string, not the Date — a raw sql`` template goes through
            // postgres.js `unsafe()`, which has no column type to serialise
            // against and throws on a Date object.
            await tx.execute(sql`
                UPDATE dealer_leads
                SET brochure_sent_at = COALESCE(brochure_sent_at, ${performedAt.toISOString()}),
                    updated_at = NOW()
                WHERE id = ${id}
            `);
        }

        return {
            commercialId: inserted[0]?.commercial_id ?? null,
            versionNo: nextVersion,
            approvalStatus,
            autoApproved: approvalMode === "auto",
            evaluation: oemEvaluation,
            termsHold: hold,
        };
    };

    const outcome = opts?.tx ? await write(opts.tx) : await db.transaction(write);

    const afterCommit = async (): Promise<{ quote_number: string | null }> => {
        // Paired touchpoint (BRD §0.10 — quote events auto-log a touchpoint).
        //
        // E-221 — a quote awaiting the CEO logs 'quote_submitted', NOT
        // 'quote_released'. Nothing has been sent: the dealer sees nothing
        // until it is approved, and the decision route writes
        // 'quote_released' at the moment of release.
        //
        // E-226 — an auto-approved quote IS released, right here. So it logs
        // 'quote_released' for the same reason the decision route does.
        // (ID 75: 'quote_released' was 'quote_sent' before the rename.)
        if (body.event_type === "quote_issue" || body.event_type === "quote_revision") {
            // Surface the deal total (product roll-up = final_price) on the
            // touchpoint so the history log shows the value at a glance.
            const total = body.final_price ?? body.price_quoted;
            const verb = body.event_type === "quote_issue" ? "issued" : "revised";
            const money = total != null ? ` — ₹${total.toLocaleString("en-IN")}` : "";

            // E-242 — an auto-approved quote is released HERE, so this is where
            // its document is produced. After the transaction, never throwing.
            // A pending quote gets NO draft — a document that could be sent
            // must not exist before the gate has been passed (§4).
            const draft =
                outcome.autoApproved && outcome.commercialId
                    ? await tryGenerateQuotationDraft(outcome.commercialId)
                    : null;

            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: outcome.autoApproved ? "quote_released" : "quote_submitted",
                performedBy: actor.id,
                remarks: outcome.autoApproved
                    ? `Quote ${verb}${money} — auto-approved and released (at or above OEM reference)` +
                      (draft ? ` — draft ${draft.quote_number}` : "")
                    : `Quote ${verb}${money} — awaiting CEO approval` +
                      (outcome.termsHold
                          ? ` (credit ${outcome.termsHold.credit_days ?? "?"} days)`
                          : ""),
                attachments: [
                    ...(draft ? [{ url: draft.quote_pdf_url, type: "quote" }] : []),
                    ...(body.quote_document_url ? [{ url: body.quote_document_url, type: "quote" }] : []),
                ],
            });

            if (outcome.autoApproved && outcome.commercialId) {
                // The rule released this with no human in the loop, so the
                // notification is the ONLY signal anyone gets that a quotation
                // is waiting to be sent.
                const [lead] = await db
                    .select({ owner: dealerLeads.current_owner_id, dealerName: dealerLeads.dealer_name })
                    .from(dealerLeads)
                    .where(eq(dealerLeads.id, id))
                    .limit(1);

                await notifyQuotationApproved({
                    leadId: id,
                    commercialId: outcome.commercialId,
                    ownerUserId: lead?.owner ?? null,
                    dealerName: lead?.dealerName ?? null,
                    quoteNumber: draft?.quote_number ?? null,
                    value: Number(total ?? 0),
                    mode: "auto",
                    draftReady: !!draft,
                });
            } else if (outcome.approvalStatus === "pending" && outcome.commercialId) {
                // E-256 — the gate parked this quote, and the CEO queue is
                // pull-only: without a push the dealer waits exactly as long as
                // it takes someone to open the dashboard.
                const [lead] = await db
                    .select({ dealerName: dealerLeads.dealer_name })
                    .from(dealerLeads)
                    .where(eq(dealerLeads.id, id))
                    .limit(1);

                const flagged = outcome.evaluation ? linesNeedingAttention(outcome.evaluation) : 0;
                const reasons = [
                    flagged > 0
                        ? `${flagged} line${flagged === 1 ? "" : "s"} below OEM reference, unpriced, or without a reference price`
                        : null,
                    outcome.termsHold
                        ? `credit terms (${outcome.termsHold.credit_days ?? "?"} days) need approval`
                        : null,
                ].filter(Boolean);

                await notifyQuotationPendingApproval({
                    leadId: id,
                    commercialId: outcome.commercialId,
                    dealerName: lead?.dealerName ?? null,
                    value: Number(total ?? 0),
                    reason: reasons.length ? reasons.join("; ") : null,
                    raisedByName: actor.name,
                });
            }
            // ID 75: a quote in the system is what makes it Commercials explained.
            await advanceLeadOnQuoteEvent(id, "created", actor.id);
            return { quote_number: draft?.quote_number ?? null };
        }
        if (body.event_type === "brochure_share") {
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "brochure_sent",
                performedBy: actor.id,
                remarks: "Brochure shared",
                attachments: body.brochure_url ? [{ url: body.brochure_url, type: "brochure" }] : [],
            });
        }
        return { quote_number: null };
    };

    return { ...outcome, afterCommit };
}
