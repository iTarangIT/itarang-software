// One agent turn, channel-agnostic: config → registry → memory → agent →
// memory. The WhatsApp router calls this inside the user's lease; a future
// in-CRM panel would call it the same way.

import type { AssistantUser, ToolName, ToolResult } from "./types";
import { assistantConfig, writesEnabledFor, type AssistantConfig } from "./config";
import { toolsFor } from "./registry";
import { buildSystemPrompt } from "./prompt";
import { loadHistory, saveHistory, toolsetStamp } from "./memory";
import { withEditContext } from "./edit";
import { logToolCall } from "./audit";
import { callTool, createToolCallingModel, runAgentTurn, type ToolCallingModel } from "./agent";
import type { ToolSpec } from "./tools/spec";

export type AgentTurnResult =
    | { kind: "ok"; text: string; results: { tool: string; result: ToolResult }[]; modelCalls: number }
    | { kind: "not_configured" }
    | { kind: "no_tools" };

export async function agentTurn(
    user: AssistantUser,
    text: string,
    opts: {
        messageId: string | null;
        now?: Date;
        config?: AssistantConfig;
        /** Tests inject a scripted model; production builds the Gemini one. */
        model?: (tools: ToolSpec[]) => ToolCallingModel;
    },
): Promise<AgentTurnResult> {
    const cfg = opts.config ?? assistantConfig();
    if (!opts.model && !cfg.apiKey) return { kind: "not_configured" };

    const writesEnabled = writesEnabledFor(user.id, cfg);
    const tools = toolsFor(user.role, writesEnabled);
    if (tools.length === 0) return { kind: "no_tools" };

    const now = opts.now ?? new Date();
    const model = opts.model
        ? opts.model(tools)
        : createToolCallingModel({ model: cfg.model, apiKey: cfg.apiKey!, tools });

    // A history built with other tools is dropped (memory.ts): stale refusals must not replay.
    const toolset = toolsetStamp(tools.map((t) => t.name));
    const history = await loadHistory(user.id, toolset, "whatsapp", now);
    // After an Edit tap, this message is a change to that card.
    const userText = await withEditContext(user, text);
    const out = await runAgentTurn(
        {
            system: buildSystemPrompt({ user, now, tools: tools.map((t) => t.name), writesEnabled }),
            history,
            userText,
        },
        { model, tools, ctx: { user, messageId: opts.messageId, now, writesEnabled }, logToolCall },
    );
    await saveHistory(user.id, toolset, [...history, ...out.turnMessages]);
    return { kind: "ok", text: out.text, results: out.results, modelCalls: out.modelCalls };
}

/**
 * Run ONE tool without the model — e.g. a tapped list row opens that lead.
 * Same path as an agent call (registry for the user's role, Zod, scope inside
 * the tool, cap + redact, audit). A tool the user doesn't have → not_found.
 */
export async function runToolDirect(
    user: AssistantUser,
    name: ToolName,
    args: unknown,
    opts: { messageId: string | null; now?: Date; config?: AssistantConfig },
): Promise<ToolResult> {
    const cfg = opts.config ?? assistantConfig();
    const writesEnabled = writesEnabledFor(user.id, cfg);
    const spec = toolsFor(user.role, writesEnabled).find((t) => t.name === name);
    if (!spec) return { kind: "not_found" };
    const { result } = await callTool({
        spec,
        name,
        args,
        ctx: { user, messageId: opts.messageId, now: opts.now ?? new Date(), writesEnabled },
        logToolCall,
    });
    return result;
}
