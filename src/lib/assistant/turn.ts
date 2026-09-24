// One agent turn, channel-agnostic: config → registry → memory → agent →
// memory. The WhatsApp router calls this inside the user's lease; a future
// in-CRM panel would call it the same way.

import type { AssistantUser, ToolResult } from "./types";
import { assistantConfig, writesEnabledFor, type AssistantConfig } from "./config";
import { toolsFor } from "./registry";
import { buildSystemPrompt } from "./prompt";
import { loadHistory, saveHistory } from "./memory";
import { logToolCall } from "./audit";
import { createToolCallingModel, runAgentTurn, type ToolCallingModel } from "./agent";
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
        /** Tests inject a scripted model; production builds the OpenAI one. */
        model?: (tools: ToolSpec[]) => ToolCallingModel;
    },
): Promise<AgentTurnResult> {
    const cfg = opts.config ?? assistantConfig();
    if (!opts.model && (!cfg.model || !cfg.openAiKey)) return { kind: "not_configured" };

    const writesEnabled = writesEnabledFor(user.id, cfg);
    const tools = toolsFor(user.role, writesEnabled);
    if (tools.length === 0) return { kind: "no_tools" };

    const now = opts.now ?? new Date();
    const model = opts.model
        ? opts.model(tools)
        : createToolCallingModel({ model: cfg.model!, apiKey: cfg.openAiKey!, tools });

    const history = await loadHistory(user.id, "whatsapp", now);
    const out = await runAgentTurn(
        {
            system: buildSystemPrompt({ user, now, tools: tools.map((t) => t.name), writesEnabled }),
            history,
            userText: text,
        },
        { model, tools, ctx: { user, messageId: opts.messageId, now, writesEnabled }, logToolCall },
    );
    await saveHistory(user.id, [...history, ...out.turnMessages]);
    return { kind: "ok", text: out.text, results: out.results, modelCalls: out.modelCalls };
}
