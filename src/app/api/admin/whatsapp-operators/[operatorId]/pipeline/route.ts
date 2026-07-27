// GET /api/admin/whatsapp-operators/[operatorId]/pipeline
// Every dealer file this operator has opened over WhatsApp, newest activity
// first, with the conversation state of whichever channel currently owns it.
//
// The join is application → operator's file session (wa_operator_session_id).
// The dealer's own session (wa_session_id) is joined separately because after a
// handoff BOTH exist and the transcript viewer needs to offer both.

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";

const READ_ROLES = ["admin", "sales_head", "ceo"];

const operatorSession = alias(whatsappOnboardingSessions, "operator_session");
const dealerSession = alias(whatsappOnboardingSessions, "dealer_session");

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ operatorId: string }> }) => {
    await requireRole(READ_ROLES);
    const { operatorId } = await ctx.params;
    if (!operatorId) return errorResponse("Operator id required", 400);

    const rows = await db
      .select({
        applicationId: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.company_name,
        ownerName: dealerOnboardingApplications.owner_name,
        dealerPhone: dealerOnboardingApplications.wa_phone,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
        reviewStatus: dealerOnboardingApplications.review_status,
        channel: dealerOnboardingApplications.onboarding_channel,
        dealerCode: dealerOnboardingApplications.dealer_code,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        createdAt: dealerOnboardingApplications.created_at,
        updatedAt: dealerOnboardingApplications.updated_at,
        handoffAt: dealerOnboardingApplications.operator_handoff_at,
        operatorSessionId: operatorSession.id,
        operatorState: operatorSession.current_state,
        operatorLastInbound: operatorSession.last_inbound_at,
        dealerSessionId: dealerSession.id,
        dealerState: dealerSession.current_state,
        dealerLastInbound: dealerSession.last_inbound_at,
      })
      .from(dealerOnboardingApplications)
      .leftJoin(
        operatorSession,
        eq(
          operatorSession.id,
          dealerOnboardingApplications.wa_operator_session_id,
        ),
      )
      .leftJoin(
        dealerSession,
        eq(dealerSession.id, dealerOnboardingApplications.wa_session_id),
      )
      .where(
        eq(dealerOnboardingApplications.onboarding_operator_id, operatorId),
      )
      .orderBy(desc(dealerOnboardingApplications.updated_at))
      .limit(200);

    return successResponse({ files: rows });
  },
);
