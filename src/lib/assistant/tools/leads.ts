// Shared projections for the read tools: queue/search rows → LeadSummary, and
// the CRM links every record carries (BRD §9.4 "a CRM link on every record").
//
// An ALLOWLIST (Invariant 8): only these fields ever leave the database in a
// tool result. Anything added to a queue row upstream does not flow through.

import type { AssistantUser, LeadSummary } from "../types";
import { crmBaseUrl } from "../config";
import { istIso, statusLabel } from "../format";

/** The user's own workspace root: /asm for an ASM, /inside-sales for an ISR. */
function workspace(user: Pick<AssistantUser, "role">): string {
    return user.role === "asm" ? "asm" : "inside-sales";
}

export function leadUrl(user: Pick<AssistantUser, "role">, leadId: string): string {
    return `${crmBaseUrl()}/${workspace(user)}/lead/${encodeURIComponent(leadId)}`;
}

/**
 * ID 196: the CRM page that logs a verified visit on a lead — the camera +
 * live-location form. Logged-in, like every CRM link (no document or action
 * without a login).
 */
export function visitCaptureUrl(leadId: string): string {
    return `${crmBaseUrl()}/visits/capture?lead=${encodeURIComponent(leadId)}`;
}

export function queueUrl(user: Pick<AssistantUser, "role">): string {
    return `${crmBaseUrl()}/${workspace(user)}`;
}

export function performanceUrl(user: Pick<AssistantUser, "role">): string {
    return `${crmBaseUrl()}/${workspace(user)}/performance`;
}

/**
 * The latest visit states that are still AHEAD of the ASM — the same pair the
 * `today` tab reads. A visited / cancelled visit's date is history, not next.
 */
export const OPEN_VISIT_STATUSES: readonly string[] = ["scheduled", "pending_scheduling"];

/** Postgres date / timestamp → IST ISO ("…+05:30"); a date-only value stays "YYYY-MM-DD". */
function iso(v: unknown): string | null {
    if (v instanceof Date) return istIso(v);
    return istIso(v == null ? null : String(v));
}

type SummarySource = {
    id: string;
    shop_name?: string | null;
    dealer_name?: string | null;
    city?: string | null;
    phone?: string | null;
    lead_status?: string | null;
    interest_level?: string | null;
    last_touchpoint_at?: unknown;
    current_owner_id?: string | null;
    current_owner_name?: string | null;
    next_follow_up_at?: unknown;
    /** The latest visit (LATEST_VISIT_JOIN) — ASM rows. */
    scheduled_date?: unknown;
    visit_status?: string | null;
};

export function toLeadSummary(row: SummarySource, user: AssistantUser): LeadSummary {
    // "Next date" means what the rep acts on next: an ISR's follow-up, an
    // ASM's latest visit — only while it is still to happen (scheduled /
    // pending scheduling); a visited or cancelled one has no next date.
    const next =
        user.role === "asm"
            ? OPEN_VISIT_STATUSES.includes(row.visit_status ?? "")
                ? (row.scheduled_date ?? null)
                : null
            : (row.next_follow_up_at ?? null);
    return {
        id: row.id,
        shop_name: row.shop_name ?? null,
        dealer_name: row.dealer_name ?? null,
        city: row.city ?? null,
        status: row.lead_status ?? null,
        status_label: row.lead_status ? statusLabel(row.lead_status) : null,
        interest: row.interest_level ?? null,
        phone: row.phone ?? null,
        last_activity_at: iso(row.last_touchpoint_at),
        owner_name: row.current_owner_name ?? null,
        owned_by_you: row.current_owner_id === user.id,
        next_date: iso(next),
        crm_url: leadUrl(user, row.id),
    };
}
