// Drill-in detail for a b2b-source converted lead. The id here is the raw
// leads.id (the table page already stripped the "ld_" prefix). We hydrate
// the deal, the most recent loan_application + loan_sanction, the KYC
// verification rollup, and the most recent ai_call_log on lead_id so the
// drawer can show the closing context without firing five client queries.

import { db } from "@/lib/db";
import {
    leads,
    deals,
    loanApplications,
    loanSanctions,
    kycVerifications,
    aiCallLogs,
} from "@/lib/db/schema";
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

    const leadRow = (await db.select().from(leads).where(eq(leads.id, id)).limit(1))[0];
    if (!leadRow) {
        return errorResponse("Lead not found", 404);
    }

    // All downstream queries are independent — fan out in parallel.
    const [dealRow, loanAppRow, sanctionRow, kycRows, latestCall] = await Promise.all([
        leadRow.converted_deal_id
            ? db.select().from(deals).where(eq(deals.id, leadRow.converted_deal_id)).limit(1).then(r => r[0] ?? null)
            : Promise.resolve(null),
        db.select().from(loanApplications).where(eq(loanApplications.lead_id, id)).orderBy(desc(loanApplications.created_at)).limit(1).then(r => r[0] ?? null),
        db.select().from(loanSanctions).where(eq(loanSanctions.lead_id, id)).orderBy(desc(loanSanctions.created_at)).limit(1).then(r => r[0] ?? null),
        db.select().from(kycVerifications).where(eq(kycVerifications.lead_id, id)),
        db.select().from(aiCallLogs).where(eq(aiCallLogs.lead_id, id)).orderBy(desc(aiCallLogs.created_at)).limit(1).then(r => r[0] ?? null),
    ]);

    return successResponse({
        source: "b2b" as const,
        lead: {
            id: leadRow.id,
            business_name: leadRow.business_name,
            full_name: leadRow.full_name,
            owner_name: leadRow.owner_name,
            phone: leadRow.phone,
            mobile: leadRow.mobile,
            state: leadRow.state,
            city: leadRow.city,
            shop_address: leadRow.shop_address,
            status: leadRow.status,
            lead_status: leadRow.lead_status,
            kyc_status: leadRow.kyc_status,
            intent_score: leadRow.intent_score,
            intent_reason: leadRow.intent_reason,
            converted_deal_id: leadRow.converted_deal_id,
            converted_at: leadRow.converted_at,
            dealer_id: leadRow.dealer_id,
            conversation_summary: leadRow.conversation_summary,
            created_at: leadRow.created_at,
        },
        deal: dealRow && {
            id: dealRow.id,
            line_total: dealRow.line_total,
            gst_amount: dealRow.gst_amount,
            total_payable: dealRow.total_payable,
            payment_term: dealRow.payment_term,
            deal_status: dealRow.deal_status,
            invoice_number: dealRow.invoice_number,
            invoice_issued_at: dealRow.invoice_issued_at,
            created_at: dealRow.created_at,
        },
        loan_application: loanAppRow && {
            id: loanAppRow.id,
            loan_amount: loanAppRow.loan_amount,
            interest_rate: loanAppRow.interest_rate,
            tenure_months: loanAppRow.tenure_months,
            emi_amount: loanAppRow.emi_amount,
            status: loanAppRow.status,
            application_status: loanAppRow.application_status,
            nbfc_name: loanAppRow.nbfc_name,
            submitted_at: loanAppRow.submitted_at,
            approved_at: loanAppRow.approved_at,
            disbursed_at: loanAppRow.disbursed_at,
        },
        loan_sanction: sanctionRow,
        kyc_verifications: kycRows.map((k) => ({
            id: k.id,
            verification_type: k.verification_type,
            status: k.status,
            match_score: k.match_score,
            completed_at: k.completed_at,
        })),
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
