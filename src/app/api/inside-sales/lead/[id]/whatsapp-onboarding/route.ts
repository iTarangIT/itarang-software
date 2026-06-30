// POST /api/inside-sales/lead/[id]/whatsapp-onboarding
// Outbound kickoff for WhatsApp dealer onboarding. The inbound webhook flow
// (lib/whatsapp/orchestrator.ts) only starts when the dealer messages first;
// this lets a rep PROACTIVELY invite a just-converted lead onto WhatsApp. It
// links a whatsapp_onboarding_sessions row to the lead's draft onboarding
// application (created by mark-converted) and sends the dealer an invite so
// their first reply continues straight into the onboarding state machine.

import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    dealerLeads,
    dealerOnboardingApplications,
    whatsappMessages,
    whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { getAdapter } from "@/lib/whatsapp";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin"];

// dealer_leads.phone is stored as 10 digits; WhatsApp wants E.164 without '+'.
function toWaPhone(raw: string | null): string | null {
    const digits = (raw || "").replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    if (digits.length >= 11 && digits.length <= 15) return digits;
    return null;
}

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(MUTATE_ROLES);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Lead id required", 400);

        const [lead] = await db
            .select({
                phone: dealerLeads.phone,
                dealer_name: dealerLeads.dealer_name,
                application_id: dealerLeads.dealer_onboarding_application_id,
            })
            .from(dealerLeads)
            .where(sql`${dealerLeads.id} = ${id}`)
            .limit(1);
        if (!lead) return errorResponse("Lead not found", 404);
        if (!lead.application_id) {
            return errorResponse(
                "No onboarding application — mark the lead Converted first.",
                400,
            );
        }

        const waPhone = toWaPhone(lead.phone);
        if (!waPhone) {
            return errorResponse("Lead has no valid phone number for WhatsApp.", 400);
        }

        // Reuse an existing session for this number, else create one linked to the
        // converted lead's draft application so the orchestrator picks it up when
        // the dealer replies. getOrCreateSession (orchestrator) keys on wa_phone.
        const existing = await db
            .select({ id: whatsappOnboardingSessions.id })
            .from(whatsappOnboardingSessions)
            .where(eq(whatsappOnboardingSessions.wa_phone, waPhone))
            .orderBy(desc(whatsappOnboardingSessions.created_at))
            .limit(1);

        let sessionId: string;
        if (existing.length > 0) {
            sessionId = existing[0].id;
            await db
                .update(whatsappOnboardingSessions)
                .set({ application_id: lead.application_id, updated_at: new Date() })
                .where(eq(whatsappOnboardingSessions.id, sessionId));
        } else {
            const [session] = await db
                .insert(whatsappOnboardingSessions)
                .values({
                    wa_phone: waPhone,
                    wa_contact_name: lead.dealer_name ?? null,
                    provider: getAdapter().provider,
                    application_id: lead.application_id,
                    current_state: "GREETING",
                    session_status: "active",
                })
                .returning();
            sessionId = session.id;
        }

        // Link the application back to the WhatsApp channel so downstream flows
        // (e.g. agreement delivery) recognise this as a WhatsApp dealer.
        await db
            .update(dealerOnboardingApplications)
            .set({ wa_phone: waPhone, wa_session_id: sessionId })
            .where(eq(dealerOnboardingApplications.id, lead.application_id));

        // Send the invite. Outside the 24h window a pre-approved template is
        // required; configure its name via env. Without one, fall back to a text
        // send (works if the dealer messaged us within 24h). Best-effort — a send
        // failure does not undo the session link.
        const adapter = getAdapter();
        const dealerName = lead.dealer_name?.trim() || "there";
        const templateName = process.env.WHATSAPP_ONBOARDING_TEMPLATE;
        const templateLang = process.env.WHATSAPP_ONBOARDING_TEMPLATE_LANG || "en";
        const inviteText =
            `👋 Hi ${dealerName}! Welcome to *iTarang* dealer onboarding.\n\n` +
            `We'll collect your business details right here on WhatsApp — it only ` +
            `takes a few minutes. Reply *Hi* to begin.`;

        let sendRes;
        try {
            sendRes = templateName
                ? await adapter.sendTemplate(waPhone, templateName, templateLang, [dealerName])
                : await adapter.sendText(waPhone, inviteText);
        } catch (err) {
            sendRes = { ok: false, providerMessageId: null, error: (err as Error).message };
        }

        await db.insert(whatsappMessages).values({
            session_id: sessionId,
            provider_message_id: sendRes.providerMessageId ?? null,
            direction: "outbound",
            message_type: templateName ? "template" : "text",
            text_body: templateName ? `template:${templateName}` : inviteText,
            delivery_status: sendRes.ok ? "sent" : "failed",
            raw_payload: ((sendRes as { raw?: unknown }).raw ?? null) as never,
        });

        return successResponse({
            sessionId,
            delivered: sendRes.ok,
            error: sendRes.ok ? null : sendRes.error ?? "WhatsApp send failed",
        });
    },
);
