/**
 * ID 204 — GET / PUT the EMI message settings (app_settings['emi_messages']).
 *
 * PUT takes the whole form. An edited text never replaces the sent one
 * directly: it becomes the PENDING text (editText) until `approve` lists that
 * message — Admin ticks it once Meta and DLT have approved the exact text.
 * GET also lists the lenders for the pilot pick.
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { getEmiMessagesSettings, setEmiMessagesSettings } from "@/lib/emi-messages/settings";
import { EMI_MESSAGE_KINDS, approveText, editText, unknownFields } from "@/lib/emi-messages/rules";
import { hasEmiMessages } from "@/lib/emi-messages/store";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "sales_head"];

const Msg = z.object({
    on: z.boolean(),
    day: z.number().int().min(-30).max(90),
    text: z.string().max(1000),
    waTemplate: z.string().trim().max(512),
    smsTemplateId: z.string().trim().max(64),
    dltTemplateId: z.string().trim().max(64),
    /** The DLT-registered SMS text (30 Oct); taken as entered — the DLT id is its approval. */
    smsText: z.string().trim().max(500).default(""),
});

const Body = z.object({
    enabled: z.boolean(),
    pilotNbfcId: z.string().uuid().nullable(),
    waLanguage: z.string().trim().min(2).max(10),
    sendFromHourIst: z.number().int().min(0).max(20),
    messages: z.record(z.enum(EMI_MESSAGE_KINDS), Msg),
    /** Messages whose pending text Meta + DLT have approved. */
    approve: z.array(z.enum(EMI_MESSAGE_KINDS)).default([]),
});

export const GET = withErrorHandler(async () => {
    await requireRole(ROLES);
    const lenders = (await db.execute(sql`
        SELECT id::text AS id, display_name AS name FROM nbfc_tenants WHERE is_active ORDER BY display_name
    `)) as unknown as Array<{ id: string; name: string }>;
    return successResponse({ settings: await getEmiMessagesSettings(), lenders, ready: await hasEmiMessages() });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ROLES);
    const body = Body.parse(await req.json());
    const prev = await getEmiMessagesSettings();
    const messages = { ...prev.messages };
    for (const k of EMI_MESSAGE_KINDS) {
        const m = body.messages[k];
        if (!m) continue;
        const bad = [...unknownFields(m.text), ...unknownFields(m.smsText)];
        if (bad.length) return errorResponse(`"${k}" uses fields that do not exist: ${bad.map((f) => `{${f}}`).join(", ")}`, 400);
        let cfg = editText(
            { ...prev.messages[k], on: m.on, day: m.day, waTemplate: m.waTemplate, smsTemplateId: m.smsTemplateId, dltTemplateId: m.dltTemplateId, smsText: m.smsText },
            m.text,
        );
        if (body.approve.includes(k)) cfg = approveText(cfg);
        messages[k] = cfg;
    }
    if (body.enabled && !body.pilotNbfcId) return errorResponse("Pick the pilot lender before switching EMI messages on.", 400);
    const settings = await setEmiMessagesSettings(
        { ...prev, enabled: body.enabled, pilotNbfcId: body.pilotNbfcId, waLanguage: body.waLanguage, sendFromHourIst: body.sendFromHourIst, messages },
        user.id,
    );
    return successResponse({ settings });
});
