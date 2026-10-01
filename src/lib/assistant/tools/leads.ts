// Shared projections for the read tools: queue/search rows → LeadSummary, and
// the CRM links every record carries (BRD §9.4 "a CRM link on every record").
//
// An ALLOWLIST (Invariant 8): only these fields ever leave the database in a
// tool result. Anything added to a queue row upstream does not flow through.

import type { AssistantUser, LeadSummary } from "../types";
import { crmBaseUrl } from "../config";

/** The user's own workspace root: /asm for an ASM, /inside-sales for an ISR. */
function workspace(user: Pick<AssistantUser, "role">): string {
    return user.role === "asm" ? "asm" : "inside-sales";
}

export function leadUrl(user: Pick<AssistantUser, "role">, leadId: string): string {
    return `${crmBaseUrl()}/${workspace(user)}/lead/${encodeURIComponent(leadId)}`;
}

export function queueUrl(user: Pick<AssistantUser, "role">): string {
    return `${crmBaseUrl()}/${workspace(user)}`;
}

export function performanceUrl(user: Pick<AssistantUser, "role">): string {
    return `${crmBaseUrl()}/${workspace(user)}/performance`;
}

/** Postgres date / timestamp (string or Date) → ISO string, or null. */
function iso(v: unknown): string | null {
    if (v == null || v === "") return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

type SummarySource = {
    id: string;
    shop_name?: string | null;
    dealer_name?: string | null;
    city?: string | null;
    lead_status?: string | null;
    interest_level?: string | null;
    current_owner_id?: string | null;
    current_owner_name?: string | null;
    next_follow_up_at?: unknown;
    scheduled_date?: unknown;
};

export function toLeadSummary(row: SummarySource, user: AssistantUser): LeadSummary {
    // "Next date" means what the rep acts on next: an ISR's follow-up, an
    // ASM's scheduled visit (their queues carry one or the other).
    const next = user.role === "asm" ? (row.scheduled_date ?? null) : (row.next_follow_up_at ?? null);
    return {
        id: row.id,
        shop_name: row.shop_name ?? null,
        dealer_name: row.dealer_name ?? null,
        city: row.city ?? null,
        status: row.lead_status ?? null,
        interest: row.interest_level ?? null,
        owner_name: row.current_owner_name ?? null,
        owned_by_you: row.current_owner_id === user.id,
        next_date: typeof next === "string" && /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : iso(next),
        crm_url: leadUrl(user, row.id),
    };
}
