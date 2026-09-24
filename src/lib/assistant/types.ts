// Channel-agnostic types for the CRM AI Assistant core (src/lib/assistant).
// Nothing here may import from a channel module (src/lib/wa-assistant) — the
// core must plug into a future in-CRM panel unchanged (BRD §8.7).

/** The only roles the Assistant serves in Phase 1 (BRD §5). */
export const ASSISTANT_ROLES = ["asm", "inside_sales_rep"] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

export function isAssistantRole(role: string | null | undefined): role is AssistantRole {
    return (ASSISTANT_ROLES as readonly string[]).includes(role ?? "");
}

/**
 * The acting user, resolved on EVERY message from a verified binding → users
 * row (never from message text, never from users.phone). Tools receive it from
 * their closure, never from model arguments.
 */
export type AssistantUser = {
    id: string;
    name: string;
    role: AssistantRole;
};

export const ROLE_LABEL: Record<AssistantRole, string> = {
    asm: "ASM",
    inside_sales_rep: "ISR",
};

// ── Tools ───────────────────────────────────────────────────────────────────

export const READ_TOOL_NAMES = ["my_queue", "search_lead", "get_lead_details", "my_numbers"] as const;
export const WRITE_TOOL_NAMES = ["log_call", "log_visit", "mark_lost", "claim_lead", "set_follow_up"] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export type ToolName = ReadToolName | WriteToolName;

/** Hard cap on rows any tool hands the model or a list message (Invariant 5, BRD §9.4). */
export const MAX_TOOL_ROWS = 10;

/** One lead as a tool hands it back: an allowlisted projection, never a raw row. */
export type LeadSummary = {
    id: string;
    shop_name: string | null;
    dealer_name: string | null;
    city: string | null;
    status: string | null;
    interest: string | null;
    owner_name: string | null;
    /** True when the acting user owns it — anything else is read-only. */
    owned_by_you: boolean;
    next_date: string | null;
    crm_url: string;
};

/**
 * What a tool returns. Plain JSON — never pre-rendered WhatsApp text. The model
 * sees it (rows capped at MAX_TOOL_ROWS); the channel renders it deterministically.
 *
 * `not_found` is deliberately bare: a lead outside the user's scope must be
 * indistinguishable from one that does not exist (Invariant 1).
 */
export type ToolResult =
    | { kind: "leads"; title: string; rows: LeadSummary[]; total: number; crm_url: string | null }
    | { kind: "candidates"; question: string; rows: LeadSummary[] }
    | { kind: "lead"; lead: Record<string, unknown> }
    | { kind: "numbers"; data: Record<string, unknown> }
    | { kind: "preview"; action_id: string; preview: Record<string, unknown> }
    | { kind: "not_found" }
    | { kind: "question"; question: string }
    | { kind: "declined"; reason: string; crm_url?: string | null }
    | { kind: "unavailable"; message: string }
    | { kind: "error"; message: string };

/** Everything a tool may know about the caller — built by the server, never by the model. */
export type ToolContext = {
    user: AssistantUser;
    /** assistant_wa_messages.id (or another channel's message id) that started the turn. */
    messageId: string | null;
    /** Server clock for the turn — relative dates resolve against this, in IST. */
    now: Date;
    writesEnabled: boolean;
};
