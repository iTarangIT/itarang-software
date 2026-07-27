// GET /api/admin/whatsapp-operators/sessions/[sessionId]/messages
// The WhatsApp transcript for one onboarding conversation, for admin support and
// dispute resolution.
//
// REDACTION IS LOAD-BEARING, NOT COSMETIC. sendDealerWelcomeWhatsApp() builds
// "🔑 *Temporary Password:* <plaintext>" and logOutbound() persists the whole
// body, so whatsapp_messages.text_body contains live dealer credentials. They are
// stripped HERE, on the server, so the raw value never crosses the wire — doing
// it in the component would ship the password to every admin browser.

import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";

const READ_ROLES = ["admin", "sales_head", "ceo"];

/**
 * Strip anything credential-shaped from a logged message body. Line-oriented so
 * the rest of the welcome message (portal URL, dealer id, next steps) stays
 * readable — an admin needs to see that the message went out and what it said.
 */
function redact(body: string | null): string | null {
  if (!body) return body;
  return body
    .replace(
      /(\*?Temporary Password:?\*?:?\s*)(\S+)/gi,
      "$1••••••••  [redacted]",
    )
    .replace(/(\*?Password:?\*?:?\s*)(\S+)/gi, "$1••••••••  [redacted]")
    .replace(/(\bOTP\b:?\s*)(\d{4,8})/gi, "$1•••• [redacted]");
}

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => {
    await requireRole(READ_ROLES);
    const { sessionId } = await ctx.params;
    if (!sessionId) return errorResponse("Session id required", 400);

    const [session] = await db
      .select({
        id: whatsappOnboardingSessions.id,
        waPhone: whatsappOnboardingSessions.wa_phone,
        kind: whatsappOnboardingSessions.session_kind,
        state: whatsappOnboardingSessions.current_state,
        applicationId: whatsappOnboardingSessions.application_id,
        operatorId: whatsappOnboardingSessions.operator_id,
      })
      .from(whatsappOnboardingSessions)
      .where(eq(whatsappOnboardingSessions.id, sessionId))
      .limit(1);
    if (!session) return errorResponse("Session not found", 404);

    // Readable iff the admin WhatsApp-Onboarding console lists the conversation:
    // an operator's per-dealer file row, or a dealer conversation attached to a
    // WhatsApp-collected application. Widened from operator-run only, because a
    // self-serve prospect's chat was unreadable — the same gap that kept them
    // invisible in the CRM until they submitted.
    //
    // This is still NOT a generic "read any chat by id" hole. An `operator_hub`
    // row is an internal team MENU whose context carries that operator's whole
    // dealer list and their in-progress draft, so it stays 403; so does a session
    // whose application isn't WhatsApp-sourced.
    let allowed = session.kind === "operator_file";
    if (!allowed && session.applicationId) {
      const [app] = await db
        .select({
          operatorId: dealerOnboardingApplications.onboarding_operator_id,
          source: dealerOnboardingApplications.source,
        })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, session.applicationId))
        .limit(1);
      allowed =
        Boolean(app?.operatorId) ||
        (session.kind === "dealer" &&
          (app?.source ?? "").toLowerCase() === "whatsapp");
    }
    if (!allowed) {
      return errorResponse("Not a WhatsApp onboarding conversation", 403);
    }

    const limit = Math.min(
      Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200,
      500,
    );

    const rows = await db
      .select({
        id: whatsappMessages.id,
        direction: whatsappMessages.direction,
        messageType: whatsappMessages.message_type,
        textBody: whatsappMessages.text_body,
        templateName: whatsappMessages.template_name,
        storagePath: whatsappMessages.storage_path,
        deliveryStatus: whatsappMessages.delivery_status,
        createdAt: whatsappMessages.created_at,
      })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.session_id, sessionId))
      .orderBy(asc(whatsappMessages.created_at))
      .limit(limit);

    return successResponse({
      session,
      messages: rows.map((m) => ({ ...m, textBody: redact(m.textBody) })),
    });
  },
);
