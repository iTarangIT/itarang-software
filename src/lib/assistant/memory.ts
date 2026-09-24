// Conversation memory (BRD §8.2): the last 20 turns per user, so "set a
// follow-up for him" resolves. Reset after 24 hours idle.
//
// A turn starts at a human message and runs to the next one; it includes the
// agent's tool calls and their (already redacted, capped) results, which is
// what lets a follow-up refer to a lead by pronoun. Tool results are clipped
// again here so memory can never grow without bound.

import { sql } from "drizzle-orm";
import {
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

/** Keep the last `maxTurns` human-started turns; clip tool results. Pure. */
export function trimTurns(messages: BaseMessage[], maxTurns = MAX_TURNS): BaseMessage[] {
    const humanIdx = messages.flatMap((m, i) => (m.getType() === "human" ? [i] : []));
    const start = humanIdx.length > maxTurns ? humanIdx[humanIdx.length - maxTurns] : (humanIdx[0] ?? messages.length);
    return messages.slice(start).map((m) => {
        if (m.getType() !== "tool") return m;
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (content.length <= TOOL_MESSAGE_MAX_CHARS) return m;
        const t = m as ToolMessage;
        return new ToolMessage({
            tool_call_id: t.tool_call_id,
            content: content.slice(0, TOOL_MESSAGE_MAX_CHARS) + "…(truncated)",
        });
    });
}

export async function loadHistory(userId: string, channel = "whatsapp", now = new Date()): Promise<BaseMessage[]> {
    const rows = await db.execute<{ messages: StoredMessage[]; last_activity_at: string | Date }>(sql`
        SELECT messages, last_activity_at FROM assistant_conversations
         WHERE user_id = ${userId}::uuid AND channel = ${channel}
    `);
    const row = rows[0];
    if (!row || !Array.isArray(row.messages)) return [];
    if (now.getTime() - new Date(row.last_activity_at).getTime() > IDLE_RESET_MS) return [];
    try {
        return mapStoredMessagesToChatMessages(row.messages);
    } catch {
        // A shape we can't read back is a reset, not an outage.
        return [];
    }
}

export async function saveHistory(userId: string, messages: BaseMessage[], channel = "whatsapp"): Promise<void> {
    const stored = mapChatMessagesToStoredMessages(trimTurns(messages));
    await db.execute(sql`
        INSERT INTO assistant_conversations (user_id, channel, messages, last_activity_at)
        VALUES (${userId}::uuid, ${channel}, ${JSON.stringify(stored)}::jsonb, now())
        ON CONFLICT (user_id, channel) DO UPDATE
           SET messages = EXCLUDED.messages, last_activity_at = now(), updated_at = now()
    `);
}
