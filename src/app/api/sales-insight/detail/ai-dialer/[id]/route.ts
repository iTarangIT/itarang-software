// Drill-in detail for an ai_dialer-source converted lead. The `id` here is
// the raw dealer_leads.id (the table page already stripped the "dl_" prefix
// before sending it). We pull the dealer row plus the most recent
// ai_call_log row that matches on phone — there's no lead_id FK on dialer
// rows that pre-date a leads-table promotion, so phone is the join key.

import { db } from "@/lib/db";
import { dealerLeads, aiCallLogs } from "@/lib/db/schema";
import { withErrorHandler, errorResponse, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { desc, eq } from "drizzle-orm";

const ALLOWED_ROLES = [
    "sales_insight",
    "sales_manager",
    "sales_head",
    "business_head",
    "ceo",
];

export const GET = withErrorHandler(async (
    _req: Request,
    context: { params: Promise<{ id: string }> } | { params: { id: string } },
) => {
    await requireRole(ALLOWED_ROLES);

    const params = await Promise.resolve(
        (context as { params: { id: string } | Promise<{ id: string }> }).params,
    );
    const id = params.id;

    const dealerRow = (await db.select().from(dealerLeads).where(eq(dealerLeads.id, id)).limit(1))[0];
    if (!dealerRow) {
        return errorResponse("Lead not found", 404);
    }

    // history is jsonb; pull the latest entry for the drawer's headline.
    const history = Array.isArray(dealerRow.follow_up_history)
        ? (dealerRow.follow_up_history as Array<Record<string, unknown>>)
        : [];
    const latest = history.length > 0 ? history[history.length - 1] : null;

    let latestCall = null;
    if (dealerRow.phone) {
        const callRows = await db
            .select()
            .from(aiCallLogs)
            .where(eq(aiCallLogs.phone_number, dealerRow.phone))
            .orderBy(desc(aiCallLogs.created_at))
            .limit(1);
        latestCall = callRows[0] ?? null;
    }

    return successResponse({
        source: "ai_dialer" as const,
        lead: {
            id: dealerRow.id,
            shop_name: dealerRow.shop_name,
            dealer_name: dealerRow.dealer_name,
            phone: dealerRow.phone,
            location: dealerRow.location,
            state: dealerRow.state,
            city: dealerRow.city,
            current_status: dealerRow.current_status,
            total_attempts: dealerRow.total_attempts,
            final_intent_score: dealerRow.final_intent_score,
            overall_summary: dealerRow.overall_summary,
            assigned_to: dealerRow.assigned_to,
            created_at: dealerRow.created_at,
        },
        latest_follow_up: latest,
        follow_up_history: history,
        latest_call: latestCall && {
            id: latestCall.id,
            call_id: latestCall.call_id,
            status: latestCall.status,
            intent_score: latestCall.intent_score,
            intent_reason: latestCall.intent_reason,
            transcript: latestCall.transcript,
            summary: latestCall.summary,
            recording_url: latestCall.recording_url,
            call_duration: latestCall.call_duration,
            started_at: latestCall.started_at,
            ended_at: latestCall.ended_at,
        },
    });
});
