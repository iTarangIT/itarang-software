// Settings › Dialer alerts — the pure half (parsing and validation), so it
// can be tested without a database. Storage and sending: dialerAlerts.ts.

import { DEFAULT_PROBE_NUMBER } from "./carrierPause";

export const DIALER_ALERTS_SETTINGS_KEY = "dialer_alerts";
export const DEFAULT_ALERT_EMAILS = ["it@itarang.com"];
/** Who E-360 alerted; used until the list has at least one user. */
export const FALLBACK_ALERT_ROLES = ["admin", "ceo", "it"];

export type DialerAlertSettings = {
    /** CRM users told by bell + email. */
    userIds: string[];
    /** Extra addresses with no CRM login (it@itarang.com). */
    emails: string[];
    /** The number the carrier probe rings. */
    probeNumber: string;
    /** Agent version label printed on the readout (e.g. "v27"). */
    agentVersion: string;
    /** "Change tested" line printed on the readout. */
    changeTested: string;
    updatedBy: string | null;
    updatedAt: string | null;
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ten-digit Indian mobile (or +91 / 0 prefixed), normalised to its ten digits. */
export function normaliseProbeNumber(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    const ten = digits.length > 10 ? digits.slice(-10) : digits;
    return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export function parseDialerAlertSettings(
    v: Record<string, unknown> | null | undefined,
    updatedAt: string | null = null,
): DialerAlertSettings {
    const value = v ?? {};
    const emails = Array.isArray(value.emails)
        ? (value.emails as unknown[]).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e))
        : DEFAULT_ALERT_EMAILS;
    return {
        userIds: Array.isArray(value.user_ids) ? [...new Set((value.user_ids as unknown[]).map(String))] : [],
        emails: [...new Set(emails)],
        probeNumber: normaliseProbeNumber(value.probe_number as string) ?? DEFAULT_PROBE_NUMBER,
        agentVersion: typeof value.agent_version === "string" ? value.agent_version.slice(0, 40) : "",
        changeTested: typeof value.change_tested === "string" ? value.change_tested.slice(0, 200) : "",
        updatedBy: typeof value.updated_by === "string" ? value.updated_by : null,
        updatedAt,
    };
}
