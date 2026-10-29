/**
 * Tracker ID 204 — EMI message settings, stored in app_settings['emi_messages']
 * (one jsonb value; the defaults are merged in on read, so a key added later
 * reads its default). Server only. Rules and defaults: ./rules.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
    EMI_MESSAGE_KINDS,
    defaultEmiMessagesSettings,
    type EmiMessageConfig,
    type EmiMessagesSettings,
} from "./rules";

export const EMI_MESSAGES_SETTINGS_KEY = "emi_messages";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const strOrNull = (v: unknown, d: string | null): string | null => (typeof v === "string" ? v : v === null ? null : d);

/** Merge a stored value over the defaults, field by field. */
export function normaliseEmiSettings(v: Record<string, unknown> | null | undefined): EmiMessagesSettings {
    const d = defaultEmiMessagesSettings();
    const src = v ?? {};
    const msgs = (src.messages ?? {}) as Record<string, Record<string, unknown>>;
    const messages = {} as EmiMessagesSettings["messages"];
    for (const k of EMI_MESSAGE_KINDS) {
        const m = msgs[k] ?? {};
        const def = d.messages[k];
        const day = Number(m.day);
        messages[k] = {
            on: typeof m.on === "boolean" ? m.on : def.on,
            day: Number.isInteger(day) && day >= -30 && day <= 90 ? day : def.day,
            text: strOrNull(m.text, def.text),
            pendingText: strOrNull(m.pendingText, def.pendingText),
            waTemplate: str(m.waTemplate, def.waTemplate),
            smsTemplateId: str(m.smsTemplateId, def.smsTemplateId),
            dltTemplateId: str(m.dltTemplateId, def.dltTemplateId),
        } satisfies EmiMessageConfig;
    }
    const hour = Number(src.sendFromHourIst);
    return {
        enabled: src.enabled === true,
        pilotNbfcId: typeof src.pilotNbfcId === "string" && src.pilotNbfcId ? src.pilotNbfcId : null,
        waLanguage: str(src.waLanguage, d.waLanguage) || d.waLanguage,
        sendFromHourIst: Number.isInteger(hour) && hour >= 0 && hour <= 21 ? hour : d.sendFromHourIst,
        messages,
        updatedBy: typeof src.updatedBy === "string" ? src.updatedBy : null,
        updatedAt: null,
    };
}

export async function getEmiMessagesSettings(): Promise<EmiMessagesSettings> {
    try {
        const r = rowsOf<{ value: Record<string, unknown> | null; updated_at: string | null }>(
            await db.execute(sql`
                SELECT value, updated_at::text AS updated_at FROM app_settings
                 WHERE key = ${EMI_MESSAGES_SETTINGS_KEY} LIMIT 1
            `),
        )[0];
        return { ...normaliseEmiSettings(r?.value), updatedAt: r?.updated_at ?? null };
    } catch {
        return defaultEmiMessagesSettings();
    }
}

export async function setEmiMessagesSettings(next: EmiMessagesSettings, updatedBy: string): Promise<EmiMessagesSettings> {
    const value = { ...next, updatedBy, updatedAt: undefined };
    const now = new Date();
    await db
        .insert(appSettings)
        .values({ key: EMI_MESSAGES_SETTINGS_KEY, value, updated_at: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
    return getEmiMessagesSettings();
}
