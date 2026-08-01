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
import { initialApprovalStatus } from "@/lib/leads/quoteApproval";

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

        const newRow = await db.transaction(async (tx) => {
            const maxRows = await tx.execute<{ max_v: number | null }>(sql`
                SELECT MAX(version_no) AS max_v FROM dealer_lead_commercials WHERE dealer_lead_id = ${id}
            `);
            const nextVersion = Number(maxRows[0]?.max_v ?? 0) + 1;

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
                    // E-221 — quote_issue / quote_revision land pending and
                    // wait for the CEO; every other event type is born
                    // approved. The row is still is_current, so the rep sees
                    // their quote on the lead immediately — it just carries a
                    // "pending approval" badge and must not go to the dealer.
                    approval_status: initialApprovalStatus(body.event_type),
                })
                .returning({ commercial_id: dealerLeadCommercials.commercial_id });

            // BRD §0.10: dealer_leads.brochure_sent_at = first brochure_share ever; never overwritten.
            if (body.event_type === "brochure_share") {
                await tx.execute(sql`
                    UPDATE dealer_leads
                    SET brochure_sent_at = COALESCE(brochure_sent_at, ${performedAt}),
                        updated_at = NOW()
                    WHERE id = ${id}
                `);
            }

            return inserted[0]?.commercial_id ?? null;
        });

        // Paired touchpoint (BRD §0.10 — quote events auto-log a touchpoint).
        //
        // E-221 — this is 'quote_submitted', NOT 'quote_sent'. Nothing has been
        // sent: the quote is now waiting on the CEO and the dealer sees nothing
        // until it is approved. The approval route writes 'quote_sent' at the
        // moment the quote is actually released. Logging a send here would put
        // a send that never happened into the lead history and into the
        // Funnel-by-Owner report, which reads these rows.
        //
        // The rep's work is still recorded the instant they do it — preparing a
        // quote is real activity, it just isn't a send.
        if (body.event_type === "quote_issue" || body.event_type === "quote_revision") {
            // Surface the deal total (product roll-up = final_price) on the
            // touchpoint so the history log shows the value at a glance.
            const total = body.final_price ?? body.price_quoted;
            await writeTouchpoint({
                dealerLeadId: id,
                touchpointType: "quote_submitted",
                performedBy: user.id,
                remarks: `Quote ${
                    body.event_type === "quote_issue" ? "issued" : "revised"
                }${
                    total != null ? ` — ₹${total.toLocaleString("en-IN")}` : ""
                } — awaiting CEO approval`,
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

        return successResponse({ commercial_id: newRow });
    },
);
