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

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
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
    /** One model request (measured max 3.7 s). Gemini sometimes sits on a request for minutes. */
    modelCallTimeoutMs: 10_000,
    /** Stalled / overloaded model requests tolerated per turn; they do not count as model calls. */
    maxFailedModelCalls: 2,
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
    /** The backup model answered at least once this turn. */
    usedBackup: boolean;
};

export type AgentDeps = {
    model: ToolCallingModel;
    tools: ToolSpec[];
    ctx: ToolContext;
    logToolCall: (r: ToolCallRecord) => Promise<void>;
    clock?: () => number;
    /** Per-request cap; default AGENT_LIMITS.modelCallTimeoutMs. */
    modelCallTimeoutMs?: number;
    /** Takes over for the rest of the turn when the model stalls or is overloaded. */
    backupModel?: ToolCallingModel | null;
};

class ModelCallTimeout extends Error {}

/** A stall, rate limit or server error — worth another try. A 400 (our bug) is not. */
function isTransientModelError(err: unknown): boolean {
    if (err instanceof ModelCallTimeout) return true;
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number") return status === 429 || status >= 500;
    const msg = err instanceof Error ? err.message : String(err);
    return /\[(429|5\d\d)[ \]]|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

/**
 * model.invoke with a deadline WE enforce. The signal alone is not enough:
 * @langchain/google-genai 2.x drops it on the non-streaming path (_generate
 * calls completionWithRetry without options), so a stalled Gemini request
 * held a WhatsApp turn for 5 minutes. The abandoned request is left to finish
 * in the background; its answer is ignored.
 */
async function invokeWithin(model: ToolCallingModel, messages: BaseMessage[], ms: number): Promise<AIMessage> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            ctrl.abort();
            reject(new ModelCallTimeout(`model call timed out after ${ms} ms`));
        }, ms);
    });
    try {
        return await Promise.race([model.invoke(messages, { signal: ctrl.signal }), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

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
    let failedCalls = 0;
    let model = deps.model;
    let usedBackup = false;

    const callCap = deps.modelCallTimeoutMs ?? AGENT_LIMITS.modelCallTimeoutMs;

    turnLoop: while (modelCalls < AGENT_LIMITS.maxModelCalls) {
        let ai: AIMessage;
        // A stalled or overloaded model is retried — on the backup model from
        // then on, when there is one. Any other error fails the turn.
        for (;;) {
            const remaining = deadline - clock();
            if (remaining <= 0) break turnLoop;
            try {
                ai = await invokeWithin(
                    model,
                    [new SystemMessage(input.system), ...input.history, ...turn],
                    Math.min(remaining, callCap),
                );
                modelCalls++;
                break;
            } catch (err) {
                if (!isTransientModelError(err)) throw err;
                failedCalls++;
                if (deps.backupModel && !usedBackup) {
                    model = deps.backupModel;
                    usedBackup = true;
                } else if (failedCalls > AGENT_LIMITS.maxFailedModelCalls) {
                    break turnLoop;
                }
            }
        }
        turn.push(ai);

        const calls = ai.tool_calls ?? [];
        if (calls.length === 0) {
            const text = contentText(ai.content).trim();
            return {
                text: clipChars(text || FALLBACK, AGENT_LIMITS.replyMaxChars),
                results,
                turnMessages: turn,
                modelCalls,
                usedBackup,
            };
        }

        for (const call of calls) {
            const spec = byName.get(call.name);
            const writeBlocked = spec?.kind === "write" && writes >= AGENT_LIMITS.maxWritesPerTurn;
            if (spec?.kind === "write" && !writeBlocked) writes++;
            const { result, ok } = await callTool({
                spec,
                name: call.name,
                args: call.args,
                ctx: deps.ctx,
                logToolCall: deps.logToolCall,
                clock,
                blocked: writeBlocked
                    ? { error: "write_limit", message: "Only one change per message. Ask the user to confirm the first one, then continue." }
                    : null,
            });
            if (ok) results.push({ tool: call.name, result });
            turn.push(new ToolMessage({ tool_call_id: call.id ?? call.name, content: JSON.stringify(result) }));
        }
    }

    return { text: FALLBACK, results, turnMessages: turn, modelCalls, usedBackup };
}

/**
 * One tool call, the only way any tool runs — from the agent loop or directly
 * (a tapped list row). Unknown tool / invalid args never reach the tool; the
 * tool gets the SERVER's context and the parsed input only; the result is
 * capped and redacted; and the call is audited before anyone sees the result
 * (a failed audit write throws — Invariant 9).
 */
export async function callTool(args: {
    spec: ToolSpec | undefined;
    name: string;
    args: unknown;
    ctx: ToolContext;
    logToolCall: (r: ToolCallRecord) => Promise<void>;
    clock?: () => number;
    /** Refuse before running (e.g. the per-turn write limit). */
    blocked?: { error: string; message: string } | null;
}): Promise<{ result: ToolResult; ok: boolean }> {
    const clock = args.clock ?? Date.now;
    const started = clock();
    let result: ToolResult;
    let ok = false;
    let error: string | null = null;
    let loggedInput: unknown = args.args;

    if (!args.spec) {
        result = { kind: "error", message: `There is no tool called ${args.name}.` };
        error = "unknown_tool";
    } else {
        const parsed = args.spec.schema.safeParse(args.args);
        if (!parsed.success) {
            result = { kind: "error", message: `Invalid arguments: ${z.prettifyError(parsed.error).slice(0, 400)}` };
            error = "invalid_arguments";
        } else if (args.blocked) {
            result = { kind: "error", message: args.blocked.message };
            error = args.blocked.error;
        } else {
            loggedInput = parsed.data;
            try {
                result = sanitizeResult(await args.spec.run(args.ctx, parsed.data));
                ok = result.kind !== "error";
            } catch (err) {
                error = err instanceof Error ? err.message : String(err);
                result = { kind: "error", message: "That lookup failed. Nothing was changed." };
            }
        }
    }

    await args.logToolCall({
        userId: args.ctx.user.id,
        messageId: args.ctx.messageId,
        tool: args.name,
        input: loggedInput,
        output: result,
        ok,
        error,
        latencyMs: clock() - started,
        actionId: result.kind === "preview" ? result.action_id : null,
    });
    return { result, ok };
}

/**
 * The production model: Google Gemini via LangChain (ChatGoogleGenerativeAI),
 * tools bound from their Zod schemas. The integration converts each schema to
 * a Gemini function declaration (dropping $schema / additionalProperties,
 * which Gemini rejects). The tool bodies here are never called by LangChain —
 * runAgentTurn dispatches every call itself, after re-validating it.
 */
export function createToolCallingModel(args: {
    model: string;
    apiKey: string;
    tools: ToolSpec[];
}): ToolCallingModel {
    const chat = new ChatGoogleGenerativeAI({
        model: args.model,
        apiKey: args.apiKey,
        temperature: 0,
        maxRetries: 1,
        // Gemini 3.x "thinks" by default; measured 3–14 s per call. Mapping one
        // WhatsApp message to a tool call does not need deep reasoning, and a
        // turn is up to 4 calls inside a 45 s budget.
        thinkingConfig: { thinkingLevel: "LOW" },
    });
    return chat.bindTools(
        args.tools.map((t) =>
            tool(async () => "", { name: t.name, description: t.description, schema: t.schema as z.ZodObject }),
        ),
    ) as unknown as ToolCallingModel;
}

/**
 * The backup: a model through OpenRouter's OpenAI-compatible API (paid, so it does
 * not share the free Gemini key's stalls). Same tools, same loop; LangChain
 * converts the Zod schemas to function declarations.
 */
export function createBackupToolCallingModel(args: {
    model: string;
    apiKey: string;
    tools: ToolSpec[];
}): ToolCallingModel {
    const chat = new ChatOpenAI({
        model: args.model,
        apiKey: args.apiKey,
        temperature: 0,
        maxRetries: 0,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: { "X-Title": "iTarang WhatsApp Assistant" },
        },
    });
    return chat.bindTools(
        args.tools.map((t) =>
            tool(async () => "", { name: t.name, description: t.description, schema: t.schema as z.ZodObject }),
        ),
    ) as unknown as ToolCallingModel;
}
