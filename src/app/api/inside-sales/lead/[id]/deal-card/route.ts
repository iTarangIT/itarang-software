// POST /api/inside-sales/lead/[id]/deal-card
//   { deal_card: { onboarding_fee, fee_waived_reason?, batteries_per_month, finance_files_per_month }, note }
//
// Tracker ID 172 (Kartik, 10 Oct): the deal card locks once the CEO approves a
// quote or the dealer says yes; after that only the Sales Head changes it, so
// the later comparison (fee invoiced, batteries ordered) means something. The
// change is written onto the lead's latest quote (not withdrawn, not rejected)
// with an audit row and a "Record corrected" note on the timeline. Not work.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { dealCardJson, hasDealCardColumns, writeDealCard } from "@/lib/leads/dealCard";
import { DEAL_CARD_EDIT_ROLES, DealCardSchema, normaliseDealCard, parseDealCard } from "@/lib/leads/dealCardRules";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { notifyLeadPerson } from "@/lib/leads/newOwnerNotice";

const BodySchema = z.object({
    deal_card: DealCardSchema,
    note: z.string().trim().min(5).max(2000),
});

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...DEAL_CARD_EDIT_ROLES]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);
        const body = BodySchema.parse(await req.json());
        const card = normaliseDealCard(body.deal_card);

        const result = await db.transaction(async (tx) => {
            if (!(await hasDealCardColumns(tx))) {
                return { status: 503 as const, message: "The deal card is not set up on this database yet (migration E-336)." };
            }
            const rows = (await tx.execute<{ commercial_id: string; version_no: number; card: unknown }>(sql`
                SELECT c.commercial_id::text AS commercial_id, c.version_no, ${dealCardJson("c")} AS card
                  FROM dealer_lead_commercials c
                 WHERE c.dealer_lead_id = ${id}
                   AND c.event_type IN ('quote_issue', 'quote_revision')
                   AND c.withdrawn_at IS NULL
                   AND c.approval_status IS DISTINCT FROM 'rejected'
                 ORDER BY c.version_no DESC
                 LIMIT 1
                 FOR UPDATE
            `)) as unknown as Array<{ commercial_id: string; version_no: number; card: unknown }>;
            const quote = rows[0];
            if (!quote) return { status: 404 as const, message: "This lead has no quote to carry a deal card." };
            const before = parseDealCard(quote.card);
            await writeDealCard(tx, quote.commercial_id, card);

            const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
            await writeTouchpoint(
                {
                    dealerLeadId: id,
                    touchpointType: "record_correction",
                    performedBy: user.id,
                    remarks:
                        `Deal card changed by the Sales Head on v${quote.version_no}: fee ${inr(card.onboarding_fee)}` +
                        `${card.onboarding_fee === 0 && card.fee_waived_reason ? ` (waived — ${card.fee_waived_reason})` : ""}, ` +
                        `${card.batteries_per_month} batteries / month, ${card.finance_files_per_month} finance files / month — ${body.note}`,
                    countsAsWork: false,
                },
                { tx },
            );
            await tx.insert(auditLogs).values({
                id: randomUUID(),
                entity_type: "dealer_lead_commercial",
                entity_id: quote.commercial_id,
                action: "deal_card_changed",
                performed_by: user.id,
                old_data: before,
                new_data: { ...card, note: body.note, dealer_lead_id: id },
                timestamp: new Date(),
            });
            return { status: 200 as const, commercialId: quote.commercial_id, versionNo: Number(quote.version_no) };
        });

        if (result.status !== 200) return errorResponse(result.message, result.status);
        // 12 Oct: the lead's owner is told the agreed numbers changed.
        const owner = (await db.execute<{ owner: string | null }>(sql`
            SELECT current_owner_id AS owner FROM dealer_leads WHERE id = ${id}
        `)) as unknown as Array<{ owner: string | null }>;
        await notifyLeadPerson({
            userId: owner[0]?.owner,
            actorId: user.id,
            leadId: id,
            type: "lead.deal_card_changed",
            title: "Deal card changed",
            message: `{by} changed the deal card on {lead} (v${result.versionNo}): ${body.note}`,
        });
        return successResponse({ commercial_id: result.commercialId, version_no: result.versionNo, deal_card: card });
    },
);
