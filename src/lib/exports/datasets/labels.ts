// ID 224 — the words a download shows instead of database codes. Pure: no
// database, so the tests can load it.

import { CONTACTABILITY_LABEL, type Contactability } from "@/lib/leads/contactabilityLabels";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

/** Closed leads: no idle count, no "idle past limit". Won is closed too. */
export const CLOSED_LEAD_STATUSES: ReadonlySet<string> = new Set(["Won", "Converted", "Lost"]);

/**
 * A lead's status as the Leads list shows it (Assigned_Not_Contacted →
 * "Assigned"). No status = "Not in pipeline": a lead from an AI dialer list
 * that has not entered the sales pipeline yet. An unknown code is shown as is.
 */
export function leadStatusText(code: unknown): string {
    if (code == null || String(code).trim() === "") return "Not in pipeline";
    const s = String(code);
    return LEAD_STATUS_LABEL[s as LeadStatus] ?? s.replace(/_/g, " ");
}

/** Contactability in words; blank = reachable. */
export function contactabilityText(code: unknown): string | null {
    if (code == null || String(code).trim() === "") return null;
    const s = String(code);
    return CONTACTABILITY_LABEL[s as Contactability] ?? s.replace(/_/g, " ");
}
