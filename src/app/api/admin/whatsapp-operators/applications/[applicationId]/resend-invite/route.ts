// POST /api/admin/whatsapp-operators/applications/[applicationId]/resend-invite
// Re-send the "reply Hi to begin" invite to the dealer's own WhatsApp number and
// (re)bind their session to this application. Same code path the operator's
// "Invite Dealer" action uses, so a re-send behaves identically to the first.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import { inviteDealerToApplication } from "@/lib/whatsapp/operator-handoff";

const WRITE_ROLES = ["admin", "sales_head"];

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ applicationId: string }> }) => {
    await requireRole(WRITE_ROLES);
    const { applicationId } = await ctx.params;
    if (!applicationId) return errorResponse("Application id required", 400);

    const body = await req.json().catch(() => ({}));

    const [application] = await db
      .select({
        id: dealerOnboardingApplications.id,
        waPhone: dealerOnboardingApplications.wa_phone,
        ownerName: dealerOnboardingApplications.owner_name,
        companyName: dealerOnboardingApplications.company_name,
        operatorSessionId: dealerOnboardingApplications.wa_operator_session_id,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, applicationId))
      .limit(1);
    if (!application) return errorResponse("Application not found", 404);
    if (!application.waPhone) {
      return errorResponse("This application has no dealer WhatsApp number.", 400);
    }

    const res = await inviteDealerToApplication({
      applicationId: application.id,
      dealerWaPhone: application.waPhone,
      dealerName: application.ownerName || application.companyName,
      // Passing the operator's file session flips the file to 'operator_handoff'
      // and carries the company type across. Omit to invite WITHOUT handing the
      // file over (the admin is just nudging the dealer).
      operatorFileSessionId:
        body?.handoff === false ? null : application.operatorSessionId,
    });

    return successResponse({
      sessionId: res.sessionId,
      delivered: res.ok,
      error: res.ok ? null : (res.error ?? "WhatsApp send failed"),
    });
  },
);
