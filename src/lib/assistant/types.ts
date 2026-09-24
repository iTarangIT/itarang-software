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
