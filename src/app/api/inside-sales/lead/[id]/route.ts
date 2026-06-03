// GET /api/inside-sales/lead/[id]
// Full bundle for Lead Detail: lead row + current commercials + commercials
// history + touchpoint history (last 100) + status history.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import type {
    LeadDetailBundle,
    LeadDetailCommercials,
    LeadDetailLead,
    LeadDetailStatusHistory,
    LeadDetailTouchpoint,
} from "@/lib/inside-sales/types";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(READ_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const leadRows = await db.execute<LeadDetailLead>(sql`
            SELECT
                dl.id,
                dl.dealer_name,
                dl.shop_name,
                dl.phone,
                dl.city,
                dl.state,
                dl.area,
                dl.pincode,
                dl.timezone,
                dl.language,
                dl.final_intent_score,
                dl.lead_status,
                dl.interest_level,
                dl.current_owner_id,
                owner.name AS current_owner_name,
                dl.last_touchpoint_at,
                dl.next_follow_up_at,
                dl.total_attempts,
                dl.assigned_at,
                dl.created_at,
                dl.updated_at,
                dl.overall_summary,
                dl.ai_session_id,
                dl.originator_id,
                originator.name AS originator_name,
                dl.closing_owner_id,
                closer.name AS closing_owner_name,
                dl.closing_role,
                dl.asm_id,
                asm.name AS asm_name,
                dl.closed_at,
                dl.pre_transfer_status,
                dl.lost_reason,
                dl.lost_reason_notes,
                dl.previous_lost_reason,
                dl.onboarding_dropout_reason,
                dl.onboarding_dropout_notes,
                dl.escalation_status,
                COALESCE(dl.escalation_count, 0) AS escalation_count,
                dl.last_escalation_id,
                dl.preliminary_payment_intent,
                COALESCE(dl.segments, '[]'::jsonb) AS segments,
                COALESCE(dl.address_history, '[]'::jsonb) AS address_history,
                dl.address_notes,
                dl.brochure_sent_at,
                dl.dealer_onboarding_application_id,
                app.onboarding_status AS onboarding_status,
                app.created_at AS onboarding_created_at
            FROM dealer_leads dl
            LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
            LEFT JOIN users originator ON originator.id::text = dl.originator_id
            LEFT JOIN users closer ON closer.id::text = dl.closing_owner_id
            LEFT JOIN users asm ON asm.id::text = dl.asm_id
            LEFT JOIN dealer_onboarding_applications app ON app.id = dl.dealer_onboarding_application_id
            WHERE dl.id = ${id}
            LIMIT 1
        `);
        const lead = leadRows[0];
        if (!lead) return errorResponse("Lead not found", 404);

        const [commercialsHistory, touchpoints, statusHistory] = await Promise.all([
            db.execute<LeadDetailCommercials>(sql`
                SELECT
                    commercial_id, version_no, is_current, event_type,
                    price_quoted::text, quote_document_url, brochure_url, brochure_sent_at,
                    credit_terms, delivery_terms, warranty_terms,
                    final_price::text, payment_method, deal_notes,
                    COALESCE(product_lines, '[]'::jsonb) AS product_lines, notes,
                    created_by, created_at, withdrawn_at
                FROM dealer_lead_commercials
                WHERE dealer_lead_id = ${id}
                ORDER BY version_no DESC
            `),
            db.execute<LeadDetailTouchpoint>(sql`
                SELECT
                    t.touchpoint_id, t.touchpoint_type, t.performed_by,
                    u.name AS performed_by_name,
                    t.performed_at, t.call_status, t.call_duration_sec, t.is_engaged,
                    t.remarks, COALESCE(t.attachments, '[]'::jsonb) AS attachments,
                    t.next_action, t.next_action_at
                FROM lead_touchpoints t
                LEFT JOIN users u ON u.id::text = t.performed_by
                WHERE t.dealer_lead_id = ${id}
                ORDER BY t.performed_at DESC
                LIMIT 100
            `),
            db.execute<LeadDetailStatusHistory>(sql`
                SELECT
                    h.history_id, h.from_status, h.to_status,
                    h.from_lost_reason, h.to_lost_reason,
                    h.changed_by, u.name AS changed_by_name,
                    h.changed_at, h.reason_notes
                FROM dealer_lead_status_history h
                LEFT JOIN users u ON u.id::text = h.changed_by
                WHERE h.dealer_lead_id = ${id}
                ORDER BY h.changed_at DESC
                LIMIT 100
            `),
        ]);

        const bundle: LeadDetailBundle = {
            lead: lead as LeadDetailLead,
            current_commercials:
                (commercialsHistory as LeadDetailCommercials[]).find((c) => c.is_current) ?? null,
            commercials_history: commercialsHistory as LeadDetailCommercials[],
            touchpoints: touchpoints as LeadDetailTouchpoint[],
            status_history: statusHistory as LeadDetailStatusHistory[],
        };
        return successResponse(bundle);
    },
);
