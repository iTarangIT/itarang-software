// The Assistant agent: one LangChain chat model with tool calling, in a
// bounded loop we own (BRD §7/§8 — "one agent with tool calling; no LangGraph").
//
// The model decides WHICH tool to call and with what; the server decides which
// tools EXIST (registry), validates every argument again with the tool's Zod
// schema, supplies the user from the closure, and caps + redacts every result
// before the model sees it. Bounds per turn:
//   • at most MAX_MODEL_CALLS model calls; the last one is offered no tools, so
//     the model has to answer in words
//   • at most one WRITE tool call (a second gets an error the model relays)
//   • a hard deadline; the model call is aborted when it passes, and tool
//     calls still queued after it are skipped
// A tool that throws becomes a generic error result; the turn continues.
//
// A turn that ends without the model's words (cap, deadline, empty reply)
// returns text "" and a `stop` cause — never a canned "Sorry": the channel
// renders whatever the tools already answered, and only says sorry when
// nothing did.

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
    /** A quote revision / document flow is 4 tool steps + the reply; 6 leaves room. */
    maxModelCalls: 6,
    maxWritesPerTurn: 1,
    turnTimeoutMs: 45_000,
    /** One model request (measured max 3.7 s). Gemini sometimes sits on a request for minutes. */
    modelCallTimeoutMs: 10_000,
    /** Stalled / overloaded model requests tolerated per turn; they do not count as model calls. */
    maxFailedModelCalls: 2,
    userTextMaxChars: 2000,
    replyMaxChars: 1000,
} as const;

/**
 * The only thing the loop needs from a model: messages in, one AI message out.
 * `noTools` = the turn's last call: the tools stay declared (the history has
 * tool calls) but the model may not call one, so it must reply in words.
 */
export type ToolCallingModel = {
    invoke(messages: BaseMessage[], options?: { signal?: AbortSignal; noTools?: boolean }): Promise<AIMessage>;
};

export type AgentTurnInput = {
    system: string;
    history: BaseMessage[];
    userText: string;
};

/**
 * Why the turn ended. "done" = the model replied (or a card was proposed);
 * "cap" = out of model calls; "timeout" = past the deadline or the model kept
 * stalling; "empty" = the model replied with nothing.
 */
export type AgentStop = "done" | "cap" | "timeout" | "empty";

export type AgentTurnOutput = {
    /** The model's reply; "" when it did not give one (see `stop`). */
    text: string;
    stop: AgentStop;
    /**
     * A second write the per-turn limit held back, as "Next: …" for the card —
     * the model sees the same line in history and can continue after Confirm.
     */
    next: string | null;
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
async function invokeWithin(model: ToolCallingModel, messages: BaseMessage[], ms: number, noTools: boolean): Promise<AIMessage> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            ctrl.abort();
            reject(new ModelCallTimeout(`model call timed out after ${ms} ms`));
        }, ms);
    });
    try {
        return await Promise.race([model.invoke(messages, { signal: ctrl.signal, ...(noTools ? { noTools } : {}) }), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Cap list results at MAX_TOOL_ROWS and scrub sensitive text (Invariants 5, 8). */
export function sanitizeResult(result: ToolResult): ToolResult {
    let r = result;
    if ((r.kind === "leads" || r.kind === "candidates") && r.rows.length > MAX_TOOL_ROWS) {
        r = { ...r, rows: r.rows.slice(0, MAX_TOOL_ROWS) };
    } else if (r.kind === "lead_report" && r.rows.length > MAX_TOOL_ROWS) {
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

/** The turn's reply once a change card is proposed (prompt rule 10's one line). */
export const PREVIEW_REPLY = "Tap Confirm to save.";

/** "mark_lost" → "mark lost": what a held-back write is called on the card. */
function toolWords(name: string): string {
    return name.replace(/_/g, " ");
}

/**
 * The closing AI message of a turn the model did not finish in words. It keeps
 * the stored history alternating (tool result → AI → next human), and tells
 * the model next time what the user was shown.
 */
function closingNote(stop: Exclude<AgentStop, "done">, answered: boolean): string {
    const why = stop === "timeout" ? "ran out of time" : stop === "cap" ? "ran out of steps" : "gave no reply";
    return answered
        ? `(This turn ${why}; the tool results above were shown to the user as they are.)`
        : `(This turn ${why}; the user was told to try again.)`;
}

export async function runAgentTurn(input: AgentTurnInput, deps: AgentDeps): Promise<AgentTurnOutput> {
    const clock = deps.clock ?? Date.now;
    const deadline = clock() + AGENT_LIMITS.turnTimeoutMs;
    const ctx: ToolContext = { ...deps.ctx, deadline };
    const byName = new Map(deps.tools.map((t) => [t.name as string, t]));
    const human = new HumanMessage(clipChars(input.userText, AGENT_LIMITS.userTextMaxChars));
    const turn: BaseMessage[] = [human];
    const results: AgentTurnOutput["results"] = [];
    let writes = 0;
    let modelCalls = 0;
    let failedCalls = 0;
    let model = deps.model;
    let usedBackup = false;
    let stop: Exclude<AgentStop, "done"> = "cap";
    /** Writes the one-per-message limit held back: "Next: …" on the card. */
    const heldBack: { name: string; args: unknown }[] = [];

    const callCap = deps.modelCallTimeoutMs ?? AGENT_LIMITS.modelCallTimeoutMs;
    const out = (text: string, s: AgentStop): AgentTurnOutput => ({
        text,
        stop: s,
        next: heldBack.length ? `Next: ${heldBack.map((h) => toolWords(h.name)).join(", ")} — ask again after you confirm.` : null,
        results,
        turnMessages: turn,
        modelCalls,
        usedBackup,
    });

    turnLoop: while (modelCalls < AGENT_LIMITS.maxModelCalls) {
        let ai: AIMessage;
        // The last call gets no tools: the model has to answer with what it has.
        const noTools = modelCalls === AGENT_LIMITS.maxModelCalls - 1;
        // A stalled or overloaded model is retried — on the backup model from
        // then on, when there is one. Any other error fails the turn.
        for (;;) {
            const remaining = deadline - clock();
            if (remaining <= 0) {
                stop = "timeout";
                break turnLoop;
            }
            try {
                ai = await invokeWithin(
                    model,
                    [new SystemMessage(input.system), ...input.history, ...turn],
                    Math.min(remaining, callCap),
                    noTools,
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
                    stop = "timeout";
                    break turnLoop;
                }
            }
        }

        const calls = ai.tool_calls ?? [];
        if (calls.length === 0) {
            const text = contentText(ai.content).trim();
            if (!text) {
                // An empty AI message is not kept: the closing note replaces it.
                stop = "empty";
                break;
            }
            turn.push(ai);
            return out(clipChars(text, AGENT_LIMITS.replyMaxChars), "done");
        }
        turn.push(ai);

        for (const call of calls) {
            // Every tool call gets its result message, even a skipped one, so
            // the stored history stays a valid call → result sequence.
            if (clock() >= deadline) {
                turn.push(
                    new ToolMessage({
                        tool_call_id: call.id ?? call.name,
                        content: JSON.stringify({ kind: "error", message: "Skipped: the turn ran out of time." }),
                    }),
                );
                continue;
            }
            const spec = byName.get(call.name);
            const writeBlocked = spec?.kind === "write" && writes >= AGENT_LIMITS.maxWritesPerTurn;
            if (spec?.kind === "write" && !writeBlocked) writes++;
            if (writeBlocked) heldBack.push({ name: call.name, args: call.args });
            const { result, ok } = await callTool({
                spec,
                name: call.name,
                args: call.args,
                ctx,
                logToolCall: deps.logToolCall,
                clock,
                blocked: writeBlocked
                    ? { error: "write_limit", message: "Only one change per message. Ask the user to confirm the first one, then continue." }
                    : null,
            });
            if (ok) results.push({ tool: call.name, result });
            turn.push(new ToolMessage({ tool_call_id: call.id ?? call.name, content: JSON.stringify(result) }));
        }

        // A card is on its way to the user: the channel shows the card, never
        // the text, and one change per message means nothing else may follow.
        // End here instead of spending a model call on "Tap Confirm" — which
        // also kept 4-step document turns (read → search → details → write)
        // from running out of model calls. The closing AI message keeps the
        // stored history alternating (tool result → model → next user turn);
        // a held-back write is named in it so the model continues after Confirm.
        if (results.some((r) => r.result.kind === "preview")) {
            const held = heldBack.map((h) => `${h.name} ${JSON.stringify(h.args)}`).join("; ");
            turn.push(new AIMessage(held ? `${PREVIEW_REPLY}\nNext (held back — one change per message): ${held}` : PREVIEW_REPLY));
            return out(PREVIEW_REPLY, "done");
        }
    }

    turn.push(new AIMessage(closingNote(stop, results.length > 0)));
    return out("", stop);
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
        // turn is up to 6 calls inside a 45 s budget.
        thinkingConfig: { thinkingLevel: "LOW" },
    });
    return withSpeakOnlyCall(chat as unknown as BindableChat, args.tools);
}

export type BindableChat = {
    bindTools(tools: unknown[], kwargs?: Record<string, unknown>): {
        invoke(messages: BaseMessage[], options?: { signal?: AbortSignal }): Promise<unknown>;
    };
};

/**
 * Bind the tools twice: normally, and with tool_choice "none" for the turn's
 * last call (`noTools`). The declarations stay — the history holds tool calls,
 * which Gemini / OpenAI reject without them — but the model may only speak.
 */
export function withSpeakOnlyCall(chat: BindableChat, tools: ToolSpec[]): ToolCallingModel {
    const lc = tools.map((t) =>
        tool(async () => "", { name: t.name, description: t.description, schema: t.schema as z.ZodObject }),
    );
    const withTools = chat.bindTools(lc);
    const speakOnly = chat.bindTools(lc, { tool_choice: "none" });
    return {
        invoke: (messages, options) =>
            (options?.noTools ? speakOnly : withTools).invoke(messages, { signal: options?.signal }) as Promise<AIMessage>,
    };
}

/**
 * The backup:a model through OpenRouter's OpenAI-compatible API (paid, so it does
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
    return withSpeakOnlyCall(chat as unknown as BindableChat, args.tools);
}
