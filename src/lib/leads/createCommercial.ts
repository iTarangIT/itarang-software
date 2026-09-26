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
import { initialApprovalStatus, isGatedQuoteEvent } from "@/lib/leads/quoteApproval";
import { tryGenerateQuotationDraft } from "@/lib/leads/quoteDraft";
import {
    notifyQuotationApproved,
    notifyQuotationPendingApproval,
} from "@/lib/notifications/events";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import {
    evaluateAgainstOemPrices,
    linesNeedingAttention,
    resolveQuoteApproval,
    type OemEvaluation,
} from "@/lib/leads/oemPricing";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const COMMERCIAL_EVENT_TYPES = [
    "brochure_share",
    "quote_issue",
    "quote_revision",
    "terms_update",
    "final_terms",
] as const;
export type CommercialEventType = (typeof COMMERCIAL_EVENT_TYPES)[number];

export type CommercialInput = {
    event_type: CommercialEventType;
    price_quoted?: number | null;
    quote_document_url?: string | null;
    brochure_url?: string | null;
    credit_terms?: string | null;
    delivery_terms?: string | null;
    warranty_terms?: string | null;
    final_price?: number | null;
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

        if (isGatedQuoteEvent(body.event_type)) {
            const lines = body.product_lines ?? [];
            // performedAt, not now(): E-230 resolves the price by its validity
            // window, so the quote must be judged against the price in force at
            // the instant the quote is stamped.
            const refs = await loadLiveOemPrices(lines, tx, performedAt);
            oemEvaluation = evaluateAgainstOemPrices(lines, refs, performedAt);
            const resolved = resolveQuoteApproval(oemEvaluation);
            approvalStatus = resolved.status;
            approvalMode = resolved.mode;
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
                price_quoted: body.price_quoted != null ? String(body.price_quoted) : null,
                quote_document_url: body.quote_document_url ?? null,
                brochure_url: body.brochure_url ?? null,
                brochure_sent_at: body.event_type === "brochure_share" ? performedAt : null,
                credit_terms: body.credit_terms ?? null,
                delivery_terms: body.delivery_terms ?? null,
                warranty_terms: body.warranty_terms ?? null,
                final_price: body.final_price != null ? String(body.final_price) : null,
                payment_method: body.payment_method ?? null,
                deal_notes: body.deal_notes ?? null,
                product_lines: body.product_lines ?? [],
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
        };
    };

    const outcome = opts?.tx ? await write(opts.tx) : await db.transaction(write);

    const afterCommit = async (): Promise<{ quote_number: string | null }> => {
        // Paired touchpoint (BRD §0.10 — quote events auto-log a touchpoint).
        //
        // E-221 — a quote awaiting the CEO logs 'quote_submitted', NOT
        // 'quote_sent'. Nothing has been sent: the dealer sees nothing until
        // it is approved, and the decision route writes 'quote_sent' at the
        // moment of release.
        //
        // E-226 — an auto-approved quote IS released, right here. So it logs
        // 'quote_sent' for the same reason the decision route does.
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
                touchpointType: outcome.autoApproved ? "quote_sent" : "quote_submitted",
                performedBy: actor.id,
                remarks: outcome.autoApproved
                    ? `Quote ${verb}${money} — auto-approved and released (at or above OEM reference)` +
                      (draft ? ` — draft ${draft.quote_number}` : "")
                    : `Quote ${verb}${money} — awaiting CEO approval`,
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

                await notifyQuotationPendingApproval({
                    leadId: id,
                    commercialId: outcome.commercialId,
                    dealerName: lead?.dealerName ?? null,
                    value: Number(total ?? 0),
                    reason:
                        flagged > 0
                            ? `${flagged} line${flagged === 1 ? "" : "s"} below OEM reference, unpriced, or without a reference price`
                            : null,
                    raisedByName: actor.name,
                });
            }
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
