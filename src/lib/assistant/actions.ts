// Pending actions (assistant_actions) — the "no silent writes" half of the
// design (Invariant 2). A write tool NEVER writes the CRM: it stores the fully
// resolved plan here as `pending`, with its preview, the lead version it was
// built on and a 10-minute expiry, and returns the preview. Only the executor
// (executor.ts), reached only from a Confirm tap, turns a pending row into
// CRM writes.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { Preview, WriteToolName } from "./types";
import { redactDeep } from "./redact";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PENDING_TTL_MINUTES = 10;

export type NewPendingAction = {
    userId: string;
    tool: WriteToolName;
    /** null only for an action that creates its lead (create_lead). */
    leadId: string | null;
    /** dealer_leads.updated_at when the preview was built (assertNotStale). */
    leadVersion: Date | null;
    /** The fully resolved plan the executor will apply — validated again at execute. */
    plan: Record<string, unknown>;
    preview: Preview;
    /** Lead fields before the change, for the audit's before/after. */
    before: Record<string, unknown>;
    sourceMessageId: string | null;
    step?: 1 | 2;
    parentActionId?: string | null;
};

/**
 * Store a proposed write. The preview is stored REDACTED (Invariant 8): it is
 * what gets shown — now, and again for a high-impact second confirmation —
 * while the plan keeps the rep's words exactly as they will be written.
 */
export async function createPending(
    a: NewPendingAction,
    opts?: { tx?: Tx },
): Promise<{ id: string; expiresAt: Date }> {
    const rows = await (opts?.tx ?? db).execute<{ id: string; expires_at: string | Date }>(sql`
        INSERT INTO assistant_actions
            (user_id, channel, tool, lead_id, lead_version, input, preview, before,
             status, step, parent_action_id, expires_at, source_message_id)
        VALUES
            (${a.userId}::uuid, 'whatsapp', ${a.tool}, ${a.leadId},
             ${a.leadVersion ? a.leadVersion.toISOString() : null}::timestamptz,
             ${JSON.stringify(a.plan)}::jsonb, ${JSON.stringify(redactDeep(a.preview))}::jsonb, ${JSON.stringify(a.before)}::jsonb,
             'pending', ${a.step ?? 1}, ${a.parentActionId ?? null}::uuid,
             now() + make_interval(mins => ${PENDING_TTL_MINUTES}),
             ${a.sourceMessageId}::uuid)
        RETURNING id, expires_at
    `);
    return { id: rows[0]!.id, expiresAt: new Date(rows[0]!.expires_at) };
}

/** Is an unexpired preview waiting for this user? (Router: typed "yes" guard.) */
export async function hasOpenPendingAction(userId: string): Promise<boolean> {
    const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM assistant_actions
         WHERE user_id = ${userId}::uuid AND status = 'pending' AND expires_at > now()
         LIMIT 1
    `);
    return rows.length > 0;
}

/** Remember which WhatsApp message carried the preview's buttons. */
export async function setActionMessageId(actionId: string, waMessageId: string): Promise<void> {
    await db.execute(sql`
        UPDATE assistant_actions SET wa_message_id = ${waMessageId}, updated_at = now() WHERE id = ${actionId}::uuid
    `);
}
