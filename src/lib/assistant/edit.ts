// Edit on a confirmation card (channel-agnostic). Tapping Edit does NOT change
// the pending action: it remembers WHICH card the rep wants to change, and
// their next message is turned into "revise that card with this change". The
// agent re-calls the same tool; the new card supersedes the old one
// (createPending), so only the corrected card can be confirmed.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { classifyUnclaimable, type CancelOutcome } from "./executor";
import { setEditing, takeEditing } from "./memory";
import type { AssistantUser, Preview } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EditOutcome = { kind: "editing"; title: string } | Exclude<CancelOutcome, { kind: "cancelled" }>;

type PendingRow = { tool: string; lead_id: string | null; preview: Preview; input: Record<string, unknown>; expires_at: string | Date };

async function livePending(actionId: string, userId: string): Promise<PendingRow | null> {
    const rows = await db.execute<PendingRow>(sql`
        SELECT tool, lead_id, preview, input, expires_at FROM assistant_actions
         WHERE id = ${actionId}::uuid AND user_id = ${userId}::uuid
           AND status = 'pending' AND step = 1 AND expires_at > now()
    `);
    return rows[0] ?? null;
}

/** Edit tap: remember the card if it is still live; otherwise say why not. */
export async function beginEdit(actionId: string, user: AssistantUser): Promise<EditOutcome> {
    if (!UUID_RE.test(actionId)) return { kind: "not_found" };
    const row = await livePending(actionId, user.id);
    if (!row) return classifyUnclaimable(actionId, user.id);
    await setEditing(user.id, { action_id: actionId, until: new Date(row.expires_at).toISOString() });
    return { kind: "editing", title: row.preview.title };
}

/**
 * The user's next message after an Edit tap, rewritten as a revision request
 * for the model — or the text unchanged when no card is being edited (or the
 * card is no longer live). Consumes the edit state either way.
 */
export async function withEditContext(user: AssistantUser, text: string): Promise<string> {
    const editing = await takeEditing(user.id);
    if (!editing || new Date(editing.until).getTime() <= Date.now()) return text;
    const row = await livePending(editing.action_id, user.id);
    if (!row) return text;
    return editRequestText(row, text);
}

/** The card's own part of an [EDIT] message; the user's words never count against it. */
export const EDIT_CONTEXT_MAX_CHARS = 1200;

function clipTo(s: string, max: number): string {
    const chars = [...s];
    return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

/**
 * The [EDIT] message: the user's change FIRST, then the card. Anything that
 * gets clipped later (the agent keeps the start of a long message) is the
 * card's details, never what the user just said. Pure.
 */
export function editRequestText(row: Pick<PendingRow, "tool" | "lead_id" | "preview" | "input">, text: string): string {
    const shown = [row.preview.title, ...row.preview.lines.map((l) => `${l.label}: ${l.value}`)].join("; ");
    const context =
        `They tapped Edit on the pending "${row.tool}" card (lead_id ${row.lead_id ?? "new lead"}). ` +
        `Call ${row.tool} again with EVERY detail unchanged except that change. ` +
        `That card showed: ${shown}. Its resolved details: ${JSON.stringify(row.input)}.`;
    return `[EDIT] The user's change: ${text}\n${clipTo(context, EDIT_CONTEXT_MAX_CHARS)}`;
}
