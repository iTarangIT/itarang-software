// Invariant 9 — every tool call is logged: who, which tool, the validated
// input, the (truncated) output, whether it succeeded, how long it took.
//
// A failed audit insert FAILS the tool call rather than letting an unlogged
// result reach the model: "everything is logged" is a rule, not a best effort.
// Proposed writes are additionally recorded in assistant_actions (Gate 4).

import { db } from "@/lib/db";
import { assistantToolCalls } from "@/lib/db/schema";

export const OUTPUT_MAX_CHARS = 4000;

/** Keep a JSON value under `max` serialised chars, marking what was cut. */
export function truncateJson(value: unknown, max = OUTPUT_MAX_CHARS): unknown {
    const s = JSON.stringify(value ?? null);
    if (s.length <= max) return value ?? null;
    return { truncated: true, chars: s.length, preview: s.slice(0, max) };
}

export type ToolCallRecord = {
    userId: string;
    messageId: string | null;
    tool: string;
    input: unknown;
    output: unknown;
    ok: boolean;
    error?: string | null;
    latencyMs: number;
    actionId?: string | null;
};

export async function logToolCall(r: ToolCallRecord): Promise<void> {
    await db.insert(assistantToolCalls).values({
        user_id: r.userId,
        message_id: r.messageId,
        tool: r.tool.slice(0, 40),
        input: truncateJson(r.input) as never,
        output: truncateJson(r.output) as never,
        ok: r.ok,
        error: r.error ? r.error.slice(0, 1000) : null,
        latency_ms: Math.round(r.latencyMs),
        action_id: r.actionId ?? null,
    });
}
