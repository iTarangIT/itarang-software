// Who is this sender? (Invariant 4, BRD §8.2 Identity.)
//
// Resolved on EVERY message: the sender's number comes from the Meta payload,
// is looked up in assistant_wa_bindings (active) and joined to users, and must
// be an active asm or inside_sales_rep. Never from message text, never from
// users.phone (free text, unvalidated — see operator-identity.ts's warning).
//
// Deactivating a user or changing their role revokes the binding (BRD §5). No
// admin route edits users.is_active/role today, so the revocation happens here,
// the first time a message arrives after the change — which is also the only
// moment it could matter. Every message is checked either way.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantWaBindings, users } from "@/lib/db/schema";
import { isAssistantRole, type AssistantUser } from "@/lib/assistant/types";

export type RevokeReason = "user_inactive" | "role_changed";

export type SenderResolution =
    | { kind: "ok"; user: AssistantUser; bindingId: string }
    | { kind: "unlinked" }
    | { kind: "revoked"; reason: RevokeReason; userId: string };

type BindingRow = {
    bindingId: string;
    userId: string;
    name: string;
    role: string;
    isActive: boolean;
};

/** The decision, without I/O. */
export function classifyBinding(row: BindingRow | null): SenderResolution {
    if (!row) return { kind: "unlinked" };
    if (!row.isActive) return { kind: "revoked", reason: "user_inactive", userId: row.userId };
    if (!isAssistantRole(row.role)) return { kind: "revoked", reason: "role_changed", userId: row.userId };
    return {
        kind: "ok",
        bindingId: row.bindingId,
        user: { id: row.userId, name: row.name, role: row.role },
    };
}

export async function resolveSender(waPhone: string): Promise<SenderResolution> {
    const rows = await db
        .select({
            bindingId: assistantWaBindings.id,
            userId: users.id,
            name: users.name,
            role: users.role,
            isActive: users.is_active,
        })
        .from(assistantWaBindings)
        .innerJoin(users, eq(users.id, assistantWaBindings.user_id))
        .where(and(eq(assistantWaBindings.wa_phone, waPhone), eq(assistantWaBindings.status, "active")))
        .limit(1);

    const decision = classifyBinding(rows[0] ?? null);
    if (decision.kind === "revoked") {
        await db
            .update(assistantWaBindings)
            .set({
                status: "revoked",
                revoked_at: sql`now()`,
                revoked_reason: decision.reason,
                updated_at: sql`now()`,
            })
            .where(and(eq(assistantWaBindings.id, rows[0]!.bindingId), eq(assistantWaBindings.status, "active")));
    }
    return decision;
}
