// Settings › Dialer alerts (Priya KPI tracker tasks 5 and 10, 4 Nov 2026).
//
// One list of people told about the AI dialer, and the probe number:
//   - the one alert per carrier pause (task 10: Kartik, Apoorv, Aditya and
//     it@itarang.com) — chosen here, not hard-coded;
//   - the nightly quality readout (task 5) goes to the same list;
//   - the number the carrier probe rings (default 9971027907);
//   - the agent version and "change tested" lines the readout prints.
//
// Stored in app_settings['dialer_alerts']; no DDL.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { emit } from "@/lib/notifications/emit";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";
import { sendEmail } from "@/lib/email/mailer";
import {
    DIALER_ALERTS_SETTINGS_KEY,
    EMAIL_RE,
    FALLBACK_ALERT_ROLES,
    normaliseProbeNumber,
    parseDialerAlertSettings,
    type DialerAlertSettings,
} from "./dialerAlertSettings";

export {
    DEFAULT_ALERT_EMAILS,
    DIALER_ALERTS_SETTINGS_KEY,
    FALLBACK_ALERT_ROLES,
    normaliseProbeNumber,
    parseDialerAlertSettings,
    type DialerAlertSettings,
} from "./dialerAlertSettings";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

export async function getDialerAlertSettings(): Promise<DialerAlertSettings> {
    try {
        const r = rowsOf<{ value: Record<string, unknown> | null; updated_at: string | null }>(
            await db.execute(sql`
                SELECT value, updated_at::text AS updated_at FROM app_settings
                 WHERE key = ${DIALER_ALERTS_SETTINGS_KEY} LIMIT 1
            `),
        )[0];
        return parseDialerAlertSettings(r?.value ?? null, r?.updated_at ?? null);
    } catch {
        return parseDialerAlertSettings(null);
    }
}

export async function setDialerAlertSettings(input: {
    userIds: string[];
    emails: string[];
    probeNumber: string;
    agentVersion: string;
    changeTested: string;
    updatedBy: string;
}): Promise<DialerAlertSettings> {
    const probe = normaliseProbeNumber(input.probeNumber);
    if (!probe) throw new Error("The probe number must be a 10-digit Indian mobile.");
    const bad = input.emails.filter((e) => !EMAIL_RE.test(e.trim()));
    if (bad.length) throw new Error(`Not an email address: ${bad.join(", ")}`);
    const value = {
        user_ids: [...new Set(input.userIds)],
        emails: [...new Set(input.emails.map((e) => e.trim().toLowerCase()))],
        probe_number: probe,
        agent_version: input.agentVersion.trim().slice(0, 40),
        change_tested: input.changeTested.trim().slice(0, 200),
        updated_by: input.updatedBy,
    };
    const now = new Date();
    await db
        .insert(appSettings)
        .values({ key: DIALER_ALERTS_SETTINGS_KEY, value, updated_at: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
    return getDialerAlertSettings();
}

/**
 * Tell the Dialer alerts list: bell + email to each chosen user (through
 * emit, so Notification Access / Email settings still apply) and a plain
 * email to each extra address. Never throws.
 */
export async function sendDialerAlert(input: {
    type: string;
    title: string;
    message: string;
    href: string;
    data?: Record<string, unknown>;
}): Promise<{ users: number; emails: number }> {
    const settings = await getDialerAlertSettings();
    let users = 0;
    let emails = 0;
    try {
        // Until someone fills the list, the roles E-360 alerted keep getting it.
        const to = settings.userIds.length
            ? settings.userIds.map((userId) => ({
                  audience: { kind: "user" as const, userId },
                  as: ADMIN_PARTY,
                  href: input.href,
              }))
            : [{ audience: { kind: "roles" as const, roles: FALLBACK_ALERT_ROLES }, as: ADMIN_PARTY, href: input.href }];
        await emit({
            type: input.type,
            title: input.title,
            message: input.message,
            stage: "AI dialer",
            email: true,
            data: input.data ?? {},
            to,
        });
        users = settings.userIds.length;
    } catch (err) {
        console.error("[dialerAlerts] bell/email to users failed:", err instanceof Error ? err.message : err);
    }
    if (settings.emails.length) {
        try {
            const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "";
            const link = base ? `${base.replace(/\/$/, "")}${input.href}` : input.href;
            await sendEmail({
                to: settings.emails,
                subject: input.title,
                text: `${input.message}\n\n${link}`,
            });
            emails = settings.emails.length;
        } catch (err) {
            console.error("[dialerAlerts] email to extra addresses failed:", err instanceof Error ? err.message : err);
        }
    }
    return { users, emails };
}
