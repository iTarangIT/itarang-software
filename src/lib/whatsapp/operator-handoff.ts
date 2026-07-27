// E-214 — bind a dealer's OWN WhatsApp number to an onboarding application and
// invite them into the chat.
//
// Two callers share this:
//   • the operator console's "Invite Dealer" action, handing the document /
//     e-sign steps over to the dealer (onboarding_channel → 'operator_handoff');
//   • POST /api/inside-sales/lead/[id]/whatsapp-onboarding, the pre-existing
//     rep-initiated invite for a just-converted lead.
//
// The routing trick: pre-creating a `session_kind='dealer'` row for the dealer's
// number pointed at THIS application means getOrCreateSession() finds it instead
// of minting a fresh draft, so the dealer's first "hi" continues the operator's
// work rather than starting over. No router change is needed.

import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import { getAdapter } from "./index";
import { loadSession } from "./session-store";

export interface InviteResult {
  ok: boolean;
  sessionId: string | null;
  error?: string;
}

export interface InviteParams {
  applicationId: string;
  /** The DEALER's own number, E.164 without '+'. */
  dealerWaPhone: string;
  dealerName?: string | null;
  /**
   * The operator's `operator_file` session, when this is a handoff. Its
   * company-type progress is copied onto the dealer's session so the checklist
   * resumes instead of re-asking. Omit for the inside-sales rep invite.
   */
  operatorFileSessionId?: string | null;
}

/**
 * Point a session on the DEALER's own number at `applicationId`, creating one if
 * they've never chatted with us, and return its id. No message is sent.
 *
 * Called at approval so the dealer's first "hi" lands on the cheap, strict
 * console gate (session → application → resolveActiveDealer) instead of falling
 * through to the phone-matched fallback, and so the welcome message has a
 * conversation to log against. Safe to call for any WhatsApp dealer.
 */
export async function bindDealerSession(
  applicationId: string,
  dealerWaPhone: string,
  dealerName: string | null,
): Promise<string | null> {
  if (!applicationId || !dealerWaPhone) return null;

  const [existing] = await db
    .select({ id: whatsappOnboardingSessions.id })
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.wa_phone, dealerWaPhone),
        ne(whatsappOnboardingSessions.session_kind, "operator_file"),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.created_at))
    .limit(1);

  let sessionId: string;
  if (existing) {
    sessionId = existing.id;
    await db
      .update(whatsappOnboardingSessions)
      .set({ application_id: applicationId, updated_at: new Date() })
      .where(eq(whatsappOnboardingSessions.id, sessionId));
  } else {
    const [created] = await db
      .insert(whatsappOnboardingSessions)
      .values({
        wa_phone: dealerWaPhone,
        wa_contact_name: dealerName,
        provider: getAdapter().provider,
        application_id: applicationId,
        session_kind: "dealer",
        current_state: "GREETING",
        session_status: "active",
      })
      .returning({ id: whatsappOnboardingSessions.id });
    sessionId = created.id;
  }

  await db
    .update(dealerOnboardingApplications)
    .set({ wa_session_id: sessionId, updated_at: new Date() })
    .where(eq(dealerOnboardingApplications.id, applicationId));

  return sessionId;
}

export async function inviteDealerToApplication(
  params: InviteParams,
): Promise<InviteResult> {
  const { applicationId, dealerWaPhone, operatorFileSessionId } = params;
  const dealerName = params.dealerName?.trim() || "there";

  if (!applicationId || !dealerWaPhone) {
    return { ok: false, sessionId: null, error: "missing_params" };
  }

  // Reuse the dealer's own session if they've ever chatted with us; otherwise
  // create one. `operator_file` rows are excluded — they carry the OPERATOR's
  // number, so matching one here would repoint the wrong conversation.
  const [existing] = await db
    .select({ id: whatsappOnboardingSessions.id })
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.wa_phone, dealerWaPhone),
        ne(whatsappOnboardingSessions.session_kind, "operator_file"),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.created_at))
    .limit(1);

  let sessionId: string;
  if (existing) {
    sessionId = existing.id;
    await db
      .update(whatsappOnboardingSessions)
      .set({ application_id: applicationId, updated_at: new Date() })
      .where(eq(whatsappOnboardingSessions.id, sessionId));
  } else {
    const [created] = await db
      .insert(whatsappOnboardingSessions)
      .values({
        wa_phone: dealerWaPhone,
        wa_contact_name: params.dealerName ?? null,
        provider: getAdapter().provider,
        application_id: applicationId,
        session_kind: "dealer",
        current_state: "GREETING",
        session_status: "active",
      })
      .returning({ id: whatsappOnboardingSessions.id });
    sessionId = created.id;
  }

  // Carry the operator's progress across. detected_company_type lives on the
  // SESSION (not the application), so without this the dealer's fresh row would
  // send them back to the company-type question and recompute an empty checklist.
  if (operatorFileSessionId) {
    const file = await loadSession(operatorFileSessionId);
    if (file?.detected_company_type) {
      const fileCtx = (file.context ?? {}) as {
        answers?: Record<string, unknown>;
      };
      const dealerSession = await loadSession(sessionId);
      const dealerCtx = (dealerSession?.context ?? {}) as {
        answers?: Record<string, unknown>;
      };
      await db
        .update(whatsappOnboardingSessions)
        .set({
          detected_company_type: file.detected_company_type,
          context: {
            ...dealerCtx,
            answers: {
              ...(dealerCtx.answers ?? {}),
              companyType: fileCtx.answers?.companyType ?? file.detected_company_type,
            },
          } as never,
          updated_at: new Date(),
        })
        .where(eq(whatsappOnboardingSessions.id, sessionId));
    }
  }

  // Link the application to the dealer's channel. wa_phone is re-asserted here
  // because it is ALWAYS the dealer's number, never the operator's.
  await db
    .update(dealerOnboardingApplications)
    .set({
      wa_phone: dealerWaPhone,
      wa_session_id: sessionId,
      ...(operatorFileSessionId
        ? {
            onboarding_channel: "operator_handoff",
            operator_handoff_at: new Date(),
          }
        : {}),
      operator_invited_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, applicationId));

  // Send the invite. Outside Meta's 24h window a pre-approved template is
  // required — in operator-upload mode the dealer has usually never messaged us,
  // so the template is the normal path, not the exception. Best-effort: a send
  // failure does not undo the session link.
  const adapter = getAdapter();
  const templateName = process.env.WHATSAPP_ONBOARDING_TEMPLATE;
  const templateLang = process.env.WHATSAPP_ONBOARDING_TEMPLATE_LANG || "en";
  const inviteText =
    `👋 Hi ${dealerName}! Welcome to *iTarang* dealer onboarding.\n\n` +
    `We'll collect your business details right here on WhatsApp — it only ` +
    `takes a few minutes. Reply *Hi* to begin.`;

  let sendRes: { ok: boolean; providerMessageId?: string | null; error?: string; raw?: unknown };
  try {
    sendRes = templateName
      ? await adapter.sendTemplate(dealerWaPhone, templateName, templateLang, [
          dealerName,
        ])
      : await adapter.sendText(dealerWaPhone, inviteText);
  } catch (err) {
    sendRes = {
      ok: false,
      providerMessageId: null,
      error: (err as Error).message,
    };
  }

  await db.insert(whatsappMessages).values({
    session_id: sessionId,
    provider_message_id: sendRes.providerMessageId ?? null,
    direction: "outbound",
    message_type: templateName ? "template" : "text",
    text_body: templateName ? `template:${templateName}` : inviteText,
    delivery_status: sendRes.ok ? "sent" : "failed",
    raw_payload: (sendRes.raw ?? null) as never,
  });

  return {
    ok: sendRes.ok,
    sessionId,
    error: sendRes.ok ? undefined : (sendRes.error ?? "WhatsApp send failed"),
  };
}
