// Conversation memory (BRD §8.2): the last 20 turns per user, so "set a
// follow-up for him" resolves. Reset after 24 hours idle.
//
// A turn starts at a human message and runs to the next one; it includes the
// agent's tool calls and their (already redacted, capped) results, which is
// what lets a follow-up refer to a lead by pronoun. Tool results are clipped
// again here so memory can never grow without bound.
//
// A history is only valid for the TOOL SET it was built with, so it is stored
// stamped with it: { toolset, messages }. When the user's tools change — a
// deploy adds one, they join or leave the write pilot — the old history is
// dropped. Replaying an old "I can't transfer leads" otherwise makes the model
// repeat it word for word without looking at the tool it now has.

import { sql } from "drizzle-orm";
import {
    AIMessage,
    HumanMessage,
    ToolMessage,
    mapChatMessagesToStoredMessages,
    mapStoredMessagesToChatMessages,
    type BaseMessage,
    type StoredMessage,
} from "@langchain/core/messages";
import { db } from "@/lib/db";

export const MAX_TURNS = 20;
export const IDLE_RESET_MS = 24 * 60 * 60 * 1000;
export const TOOL_MESSAGE_MAX_CHARS = 1500;
/** A quote is re-sent whole on a revision (prompt rule 16) — clipping it loses lines. */
export const QUOTE_MESSAGE_MAX_CHARS = 8000;
/** A compacted list (10 rows of id / shop / city / phone) fits whole. */
export const LIST_MESSAGE_MAX_CHARS = 2500;

type Row = Record<string, unknown>;

/**
 * A list result as memory keeps it: which leads, in the order shown, with what
 * a follow-up needs to point at one ("teesre wale", "Sharma wala ka number").
 * Clipping the raw JSON instead cut the list after two or three rows. Pure.
 */
export function compactToolContent(content: string): string {
    let r: Row;
    try {
        r = JSON.parse(content) as Row;
    } catch {
        return content;
    }
    if (!r || typeof r !== "object" || !Array.isArray(r.rows)) return content;
    if (r.kind !== "leads" && r.kind !== "candidates" && r.kind !== "lead_report") return content;
    const rows = (r.rows as Row[]).map((x) => ({ id: x.id, shop_name: x.shop_name, city: x.city, phone: x.phone }));
    return JSON.stringify({
        kind: r.kind,
        ...(r.kind === "candidates" ? { question: r.question } : { title: r.title, total: r.total }),
        rows,
    });
}

/** Keep the last `maxTurns` human-started turns; compact lists, clip tool results. Pure. */
export function trimTurns(messages: BaseMessage[], maxTurns = MAX_TURNS): BaseMessage[] {
    const humanIdx = messages.flatMap((m, i) => (m.getType() === "human" ? [i] : []));
    const start = humanIdx.length > maxTurns ? humanIdx[humanIdx.length - maxTurns] : (humanIdx[0] ?? messages.length);
    return messages.slice(start).map((m) => {
        if (m.getType() !== "tool") return m;
        const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const content = compactToolContent(raw);
        const max = content.startsWith('{"kind":"quote"')
            ? QUOTE_MESSAGE_MAX_CHARS
            : content !== raw
              ? LIST_MESSAGE_MAX_CHARS
              : TOOL_MESSAGE_MAX_CHARS;
        if (content === raw && content.length <= max) return m;
        const t = m as ToolMessage;
        return new ToolMessage({
            tool_call_id: t.tool_call_id,
            content: content.length <= max ? content : content.slice(0, max) + "…(truncated)",
        });
    });
}

/** The tool set a history belongs to: its tool names, order-independent. */
export function toolsetStamp(tools: readonly string[]): string {
    return [...tools].sort().join(",");
}

/**
 * The stored column → messages, or null to start fresh: a different tool set,
 * an unstamped (pre-stamp) history, or a shape we can't read. Pure.
 */
export function historyFromStored(raw: unknown, toolset: string): StoredMessage[] | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const h = raw as { toolset?: unknown; messages?: unknown };
    if (h.toolset !== toolset || !Array.isArray(h.messages)) return null;
    return h.messages as StoredMessage[];
}

export async function loadHistory(
    userId: string,
    toolset: string,
    channel = "whatsapp",
    now = new Date(),
): Promise<BaseMessage[]> {
    const rows = await db.execute<{ messages: unknown; last_activity_at: string | Date }>(sql`
        SELECT messages, last_activity_at FROM assistant_conversations
         WHERE user_id = ${userId}::uuid AND channel = ${channel}
    `);
    const row = rows[0];
    if (!row) return [];
    if (now.getTime() - new Date(row.last_activity_at).getTime() > IDLE_RESET_MS) return [];
    const stored = historyFromStored(row.messages, toolset);
    if (!stored) return [];
    try {
        return mapStoredMessagesToChatMessages(stored);
    } catch {
        // A shape we can't read back is a reset, not an outage.
        return [];
    }
}

/** The card an Edit tap is waiting to revise. */
export type EditingState = { action_id: string; until: string };

/** Remember the card being edited (kept beside the history in the same jsonb). */
export async function setEditing(userId: string, editing: EditingState, channel = "whatsapp"): Promise<void> {
    await db.execute(sql`
        INSERT INTO assistant_conversations (user_id, channel, messages, last_activity_at)
        VALUES (${userId}::uuid, ${channel}, ${JSON.stringify({ editing })}::jsonb, now())
        ON CONFLICT (user_id, channel) DO UPDATE
           SET messages = jsonb_set(
                   CASE WHEN jsonb_typeof(assistant_conversations.messages) = 'object'
                        THEN assistant_conversations.messages ELSE '{}'::jsonb END,
                   '{editing}', ${JSON.stringify(editing)}::jsonb),
               updated_at = now()
    `);
}

/** Read AND clear the edit state — an Edit applies to the next message only. */
export async function takeEditing(userId: string, channel = "whatsapp"): Promise<EditingState | null> {
    const rows = await db.execute<{ editing: EditingState | null }>(sql`
        SELECT messages -> 'editing' AS editing FROM assistant_conversations
         WHERE user_id = ${userId}::uuid AND channel = ${channel} AND jsonb_typeof(messages) = 'object'
    `);
    const editing = rows[0]?.editing ?? null;
    if (editing) {
        await db.execute(sql`
            UPDATE assistant_conversations SET messages = messages - 'editing', updated_at = now()
             WHERE user_id = ${userId}::uuid AND channel = ${channel}
        `);
    }
    return editing;
}

export async function saveHistory(
    userId: string,
    toolset: string,
    messages: BaseMessage[],
    channel = "whatsapp",
): Promise<void> {
    const stored = { toolset, messages: mapChatMessagesToStoredMessages(trimTurns(messages)) };
    // Merged, not replaced: an Edit tap during this turn set `editing` beside
    // the history, and it must survive this save.
    await db.execute(sql`
        INSERT INTO assistant_conversations (user_id, channel, messages, last_activity_at)
        VALUES (${userId}::uuid, ${channel}, ${JSON.stringify(stored)}::jsonb, now())
        ON CONFLICT (user_id, channel) DO UPDATE
           SET messages = CASE WHEN jsonb_typeof(assistant_conversations.messages) = 'object'
                               THEN assistant_conversations.messages ELSE '{}'::jsonb END || EXCLUDED.messages,
               last_activity_at = now(), updated_at = now()
    `);
}

/**
 * A tap the model never saw (a list row, Confirm, Cancel, Edit) as a short
 * human / AI pair at the end of the stored history, so "save hua?" or "uska
 * number" after a tap has something to go on. Only onto a live history (same
 * idle rule as loadHistory); no tool calls, so the call → result pairing is
 * untouched. Run under the user's lease so an agent turn's save can't drop it.
 */
export async function appendHistory(
    userId: string,
    note: { human: string; ai: string },
    channel = "whatsapp",
): Promise<void> {
    const pair = mapChatMessagesToStoredMessages([new HumanMessage(note.human), new AIMessage(note.ai)]);
    await db.execute(sql`
        UPDATE assistant_conversations
           SET messages = jsonb_set(messages, '{messages}', (messages -> 'messages') || ${JSON.stringify(pair)}::jsonb),
               last_activity_at = now(), updated_at = now()
         WHERE user_id = ${userId}::uuid AND channel = ${channel}
           AND jsonb_typeof(messages) = 'object' AND jsonb_typeof(messages -> 'messages') = 'array'
           AND last_activity_at > now() - make_interval(secs => ${IDLE_RESET_MS / 1000})
    `);
}
