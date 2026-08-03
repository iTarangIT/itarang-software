// POST /api/inside-sales/lead/[id]/commercials
// Create a new versioned commercials row (BRD §0.10). Flips prior is_current
// to false and inserts version_no = max+1 atomically. If event_type is a
// quote_issue/quote_revision, also writes a touchpoint of type 'quote_sent';
// if brochure_share, sets dealer_leads.brochure_sent_at on first event.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { dealerLeadCommercials } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { assertOwner } from "@/lib/leads/ownership";
import { initialApprovalStatus, isGatedQuoteEvent } from "@/lib/leads/quoteApproval";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import {
    evaluateAgainstOemPrices,
    resolveQuoteApproval,
    type OemEvaluation,
} from "@/lib/leads/oemPricing";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

const BodySchema = z.object({
    event_type: z.enum([
        "brochure_share",
        "quote_issue",
        "quote_revision",
        "terms_update",
        "final_terms",
    ]),
    price_quoted: z.number().nonnegative().nullable().optional(),
    quote_document_url: z.string().url().max(2000).nullable().optional(),
    brochure_url: z.string().url().max(2000).nullable().optional(),
    credit_terms: z.string().max(2000).nullable().optional(),
    delivery_terms: z.string().max(2000).nullable().optional(),
    warranty_terms: z.string().max(2000).nullable().optional(),
    final_price: z.number().nonnegative().nullable().optional(),
    payment_method: z.enum(["cash", "finance"]).nullable().optional(),
    deal_notes: z.string().max(5000).nullable().optional(),
    // Structured product line-items (E-128) — sourced from product_master_*.
    product_lines: z
        .array(
            z.object({
                asset_type: z.enum(["battery", "charger", "paraphernalia"]),
                product_id: z.string().min(1),
                product_name: z.string().min(1).max(200),
                model_id: z.string().max(100),
                unit_price: z.number().nonnegative().nullable(),
                quantity: z.number().int().positive().max(100000),
            }),
        )
        .max(100)
        .optional(),
    notes: z.string().max(5000).nullable().optional(),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());

        await assertOwner(id, user.id);

        const performedAt = new Date();

        const outcome = await db.transaction(async (tx) => {
            const maxRows = await tx.execute<{ max_v: number | null }>(sql`
                SELECT MAX(version_no) AS max_v FROM dealer_lead_commercials WHERE dealer_lead_id = ${id}
            `);
            const nextVersion = Number(maxRows[0]?.max_v ?? 0) + 1;

            // E-226 — the gate is now price-aware. A quote whose every line is
            // at or above its OEM reference price releases immediately; one
            // line below reference, one the rep left unpriced, or one product
            // with no reference on file still waits for the CEO.
            //
            // Read inside this transaction so the prices judged against are the
            // ones live at the instant the quote is written — a revision landing
            // mid-request cannot half-apply.
            let approvalStatus: string = initialApprovalStatus(body.event_type);
            let approvalMode: string | null = null;
            let oemEvaluation: OemEvaluation | null = null;

            if (isGatedQuoteEvent(body.event_type)) {
                const lines = body.product_lines ?? [];
                const refs = await loadLiveOemPrices(lines, tx);
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
                    brochure_sent_at:
                        body.event_type === "brochure_share" ? performedAt : null,
                    credit_terms: body.credit_terms ?? null,
                    delivery_terms: body.delivery_terms ?? null,
                    warranty_terms: body.warranty_terms ?? null,
                    final_price: body.final_price != null ? String(body.final_price) : null,
                    payment_method: body.payment_method ?? null,
                    deal_notes: body.deal_notes ?? null,
                    product_lines: body.product_lines ?? [],
                    notes: body.notes ?? null,
                    created_by: user.id,
                    // E-221 + E-226 — a gated quote lands 'pending' unless the
                    // OEM price check clears every line, in which case it is
                    // born 'approved'. Every other event type is born approved
                    // as before. The row is is_current either way, so the rep
                    // sees their quote on the lead immediately; a pending one
                    // carries the badge and must not go to the dealer.
                    approval_status: approvalStatus,
                    approval_mode: approvalMode,
                    oem_evaluation: oemEvaluation,
                    // Auto-approval stamps the time but leaves approved_by
                    // NULL: no human approved this, and NULL says so exactly.
                    // A 'system' sentinel would be a non-uuid string in the
                    // column the CEO queue joins to users.
                    approved_at: approvalMode === "auto" ? performedAt : null,
                })
                .returning({ commercial_id: dealerLeadCommercials.commercial_id });

            // BRD §0.10: dealer_leads.brochure_sent_at = first brochure_share ever; never overwritten.
            if (body.event_type === "brochure_share") {
                // ISO string, not the Date — a raw sql`` template goes through
                // postgres.js `unsafe()`, which has no column type to serialise
                // against and throws on a Date object. (The query builder above
                // takes `performedAt` directly and is fine; only raw templates
                // need this.)
                await tx.execute(sql`
                    UPDATE dealer_leads
                    SET brochure_sent_at = COALESCE(brochure_sent_at, ${performedAt.toISOString()}),
                        updated_at = NOW()
                    WHERE id = ${id}
                `);
            }

            return {
                commercialId: inserted[0]?.commercial_id ?? null,
                approvalStatus,
                autoApproved: approvalMode === "auto",
                evaluation: oemEvaluation,
            };
        });

        // Paired touchpoint (BRD §0.10 — quote events auto-log a touchpoint).
        //
        // E-221 — a quote awaiting the CEO logs 'quote_submitted', NOT
        // 'quote_sent'. Nothing has been sent: the dealer sees nothing until it
        // is approved, and the decision route writes 'quote_sent' at the moment
        // of release. Logging a send here would put a send that never happened
        // into the lead history and into the Funnel-by-Owner report.
        //
        // E-226 — an auto-approved quote IS released, right here. So it logs
        // 'quote_sent' for the same reason the decision route does: this is the
        // moment it went to the dealer, and there is no later event to record
        // it. The rep's work is recorded the instant they do it either way.
        if (body.event_type === "quote_issue" || body.event_type === "quote_revision") {
            // Surface the deal total (product roll-up = final_price) on the
            // touchpoint so the history log shows the value at a glance.
            const total = body.final_price ?? body.price_quoted;
            const verb = body.event_type === "quote_issue" ? "issued" : "revised";
            const money = total != null ? ` — ₹${total.toLocaleString("en-IN")}` : "";
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: outcome.autoApproved ? "quote_sent" : "quote_submitted",
                performedBy: user.id,
                remarks: outcome.autoApproved
                    ? `Quote ${verb}${money} — auto-approved and released (at or above OEM reference)`
                    : `Quote ${verb}${money} — awaiting CEO approval`,
                attachments: body.quote_document_url
                    ? [{ url: body.quote_document_url, type: "quote" }]
                    : [],
            });
        } else if (body.event_type === "brochure_share") {
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "brochure_sent",
                performedBy: user.id,
                remarks: "Brochure shared",
                attachments: body.brochure_url
                    ? [{ url: body.brochure_url, type: "brochure" }]
                    : [],
            });
        }

        // The modal tells the rep what happened to their quote — released, or
        // waiting and why. Without this they would have to guess from the
        // badge whether the dealer has seen it.
        return successResponse({
            commercial_id: outcome.commercialId,
            approval_status: outcome.approvalStatus,
            auto_approved: outcome.autoApproved,
            oem_evaluation: outcome.evaluation,
        });
    },
);
