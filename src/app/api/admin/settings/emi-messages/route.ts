/**
 * ID 204 — GET / PUT the EMI message settings (app_settings['emi_messages']).
 *
 * PUT takes the whole form. An edited text never replaces the sent one
 * directly: it becomes the PENDING text (editText) until `approve` lists that
 * message — Admin ticks it once Meta and DLT have approved the exact text.
 * GET also lists the lenders for the per-financer switches.
 *
 * 4 Nov: `lenders` — SMS / WhatsApp on or off per financer (replaces the one
 * pilot lender); `sms` — the SMS plan: days before, the due-day "आज" SMS,
 * the overdue cadence, and the 34 DLT templates (./sms-plan.ts). Admin and
 * Sales Head both set them.
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { getEmiMessagesSettings, setEmiMessagesSettings } from "@/lib/emi-messages/settings";
import { EMI_MESSAGE_KINDS, approveText, editText, unknownFields } from "@/lib/emi-messages/rules";
import { hasEmiMessages, hasEmiSmsKinds } from "@/lib/emi-messages/store";
import { OVERDUE_MODES, cleanDays, normaliseSmsPlan } from "@/lib/emi-messages/sms-plan";

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

const Tpl = z.object({
    dltTemplateId: z.string().trim().max(64),
    text: z.string().trim().min(1).max(1000),
});

const SmsPlan = z.object({
    beforeDays: z.array(z.number().int().min(1).max(30)).max(10),
    dueToday: z.boolean(),
    overdue: z.object({
        on: z.boolean(),
        mode: z.enum(OVERDUE_MODES),
        every: z.number().int().min(2).max(30),
        days: z.array(z.number().int().min(1).max(180)).max(30),
        stopAfter: z.number().int().min(1).max(180),
    }),
    reminders: z.array(Tpl).length(31),
    dueTodayTpl: Tpl,
    overdueTpl: Tpl,
    receivedTpl: Tpl,
});

const Body = z.object({
    enabled: z.boolean(),
    pilotNbfcId: z.string().uuid().nullable().default(null),
    lenders: z.record(z.string().uuid(), z.object({ sms: z.boolean(), whatsapp: z.boolean() })).default({}),
    sms: SmsPlan.optional(),
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
    return successResponse({
        settings: await getEmiMessagesSettings(),
        lenders,
        ready: await hasEmiMessages(),
        smsReady: await hasEmiSmsKinds(),
    });
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
    // Only financers switched on for something are kept.
    const lenders = Object.fromEntries(Object.entries(body.lenders).filter(([, v]) => v.sms || v.whatsapp));
    if (body.enabled && !Object.keys(lenders).length) {
        return errorResponse("Switch SMS or WhatsApp on for at least one financer before switching EMI messages on.", 400);
    }
    let sms = prev.sms;
    if (body.sms) {
        const texts = [...body.sms.reminders, body.sms.dueTodayTpl, body.sms.overdueTpl, body.sms.receivedTpl].map((t) => t.text);
        const bad = [...new Set(texts.flatMap((t) => unknownFields(t)))];
        if (bad.length) return errorResponse(`An SMS text uses fields that do not exist: ${bad.map((f) => `{${f}}`).join(", ")}`, 400);
        sms = normaliseSmsPlan({
            ...body.sms,
            beforeDays: cleanDays(body.sms.beforeDays, 1, 30),
            overdue: { ...body.sms.overdue, days: cleanDays(body.sms.overdue.days, 1, 180) },
        });
        if (sms.overdue.on && sms.overdue.mode === "days" && !sms.overdue.days.length) {
            return errorResponse("Give the overdue days the SMS should go on (e.g. 1, 3, 7).", 400);
        }
    }
    const settings = await setEmiMessagesSettings(
        {
            ...prev,
            enabled: body.enabled,
            // Kept for old readers only; the switches are in `lenders`.
            pilotNbfcId: body.pilotNbfcId ?? prev.pilotNbfcId,
            lenders,
            sms,
            waLanguage: body.waLanguage,
            sendFromHourIst: body.sendFromHourIst,
            messages,
        },
        user.id,
    );
    return successResponse({ settings });
});
