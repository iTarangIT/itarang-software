// The Assistant agent: one LangChain chat model with tool calling, in a
// bounded loop we own (BRD §7/§8 — "one agent with tool calling; no LangGraph").
//
// The model decides WHICH tool to call and with what; the server decides which
// tools EXIST (registry), validates every argument again with the tool's Zod
// schema, supplies the user from the closure, and caps + redacts every result
// before the model sees it. Bounds per turn:
//   • at most MAX_MODEL_CALLS model calls
//   • at most one WRITE tool call (a second gets an error the model relays)
//   • a hard deadline; the model call is aborted when it passes
// A tool that throws becomes a generic error result; the turn continues.

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { MAX_TOOL_ROWS, type ToolContext, type ToolResult } from "./types";
import type { ToolSpec } from "./tools/spec";
import { redactDeep } from "./redact";
import type { ToolCallRecord } from "./audit";

export const AGENT_LIMITS = {
    maxModelCalls: 4,
    maxWritesPerTurn: 1,
    turnTimeoutMs: 45_000,
    userTextMaxChars: 2000,
    replyMaxChars: 1000,
} as const;

/** The only thing the loop needs from a model: messages in, one AI message out. */
export type ToolCallingModel = {
    invoke(messages: BaseMessage[], options?: { signal?: AbortSignal }): Promise<AIMessage>;
};

export type AgentTurnInput = {
    system: string;
    history: BaseMessage[];
    userText: string;
};

export type AgentTurnOutput = {
    text: string;
    /** Successful tool results, in call order — what the channel renders. */
    results: { tool: string; result: ToolResult }[];
    /** This turn's messages (human → … → final AI), to append to memory. */
    turnMessages: BaseMessage[];
    modelCalls: number;
};

export type AgentDeps = {
    model: ToolCallingModel;
    tools: ToolSpec[];
    ctx: ToolContext;
    logToolCall: (r: ToolCallRecord) => Promise<void>;
    clock?: () => number;
};

/** Cap list results at MAX_TOOL_ROWS and scrub sensitive text (Invariants 5, 8). */
export function sanitizeResult(result: ToolResult): ToolResult {
    let r = result;
    if ((r.kind === "leads" || r.kind === "candidates") && r.rows.length > MAX_TOOL_ROWS) {
        r = { ...r, rows: r.rows.slice(0, MAX_TOOL_ROWS) };
    }
    return redactDeep(r);
}

function contentText(content: AIMessage["content"]): string {
    if (typeof content === "string") return content;
    return content
        .map((p) => (typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : ""))
        .join("");
}

function clipChars(s: string, max: number): string {
    const chars = [...s];
    return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

const FALLBACK = "Sorry, I couldn't finish that. Please try again with a shorter message.";

export async function runAgentTurn(input: AgentTurnInput, deps: AgentDeps): Promise<AgentTurnOutput> {
    const clock = deps.clock ?? Date.now;
    const deadline = clock() + AGENT_LIMITS.turnTimeoutMs;
    const byName = new Map(deps.tools.map((t) => [t.name as string, t]));
    const human = new HumanMessage(clipChars(input.userText, AGENT_LIMITS.userTextMaxChars));
    const turn: BaseMessage[] = [human];
    const results: AgentTurnOutput["results"] = [];
    let writes = 0;
    let modelCalls = 0;

    while (modelCalls < AGENT_LIMITS.maxModelCalls) {
        const remaining = deadline - clock();
        if (remaining <= 0) break;
        modelCalls++;
        const ai = await deps.model.invoke([new SystemMessage(input.system), ...input.history, ...turn], {
            signal: AbortSignal.timeout(remaining),
        });
        turn.push(ai);

        const calls = ai.tool_calls ?? [];
        if (calls.length === 0) {
            const text = contentText(ai.content).trim();
            return {
                text: clipChars(text || FALLBACK, AGENT_LIMITS.replyMaxChars),
                results,
                turnMessages: turn,
                modelCalls,
            };
        }

        for (const call of calls) {
            const started = clock();
            const spec = byName.get(call.name);
            let result: ToolResult;
            let ok = false;
            let error: string | null = null;
            let loggedInput: unknown = call.args;

            if (!spec) {
                result = { kind: "error", message: `There is no tool called ${call.name}.` };
                error = "unknown_tool";
            } else {
                const parsed = spec.schema.safeParse(call.args);
                if (!parsed.success) {
                    result = {
                        kind: "error",
                        message: `Invalid arguments: ${z.prettifyError(parsed.error).slice(0, 400)}`,
                    };
                    error = "invalid_arguments";
                } else if (spec.kind === "write" && writes >= AGENT_LIMITS.maxWritesPerTurn) {
                    result = {
                        kind: "error",
                        message: "Only one change per message. Ask the user to confirm the first one, then continue.",
                    };
                    error = "write_limit";
                } else {
                    loggedInput = parsed.data;
                    if (spec.kind === "write") writes++;
                    try {
                        result = sanitizeResult(await spec.run(deps.ctx, parsed.data));
                        ok = result.kind !== "error";
                    } catch (err) {
                        error = err instanceof Error ? err.message : String(err);
                        result = { kind: "error", message: "That lookup failed. Nothing was changed." };
                    }
                }
            }

            // Invariant 9: logged before the model sees it; a failed log fails the turn.
            await deps.logToolCall({
                userId: deps.ctx.user.id,
                messageId: deps.ctx.messageId,
                tool: call.name,
                input: loggedInput,
                output: result,
                ok,
                error,
                latencyMs: clock() - started,
                actionId: result.kind === "preview" ? result.action_id : null,
            });
            if (ok) results.push({ tool: call.name, result });
            turn.push(new ToolMessage({ tool_call_id: call.id ?? call.name, content: JSON.stringify(result) }));
        }
    }

    return { text: FALLBACK, results, turnMessages: turn, modelCalls };
}

/** The production model: OpenAI via LangChain, tools bound from their Zod schemas. */
export function createToolCallingModel(args: {
    model: string;
    apiKey: string;
    tools: ToolSpec[];
}): ToolCallingModel {
    const chat = new ChatOpenAI({
        model: args.model,
        apiKey: args.apiKey,
        temperature: 0,
        maxRetries: 1,
    });
    return chat.bindTools(
        args.tools.map((t) => ({
            type: "function" as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>,
            },
        })),
    ) as unknown as ToolCallingModel;
}
