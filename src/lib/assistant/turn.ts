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
import {
    AGENT_LIMITS,
    callTool,
    createBackupToolCallingModel,
    createToolCallingModel,
    runAgentTurn,
    type AgentStop,
    type ToolCallingModel,
} from "./agent";
import type { ToolSpec } from "./tools/spec";
import { pendingMedia, pendingMediaContext, type MediaRow } from "./media";

/** A host without E-311 has no attachments — never a failed turn. */
async function pendingMediaOrNone(userId: string): Promise<MediaRow[]> {
    try {
        return await pendingMedia(userId);
    } catch {
        return [];
    }
}

export type AgentTurnResult =
    | {
          kind: "ok";
          /** The model's reply; "" when the turn stopped without one (`stop`). */
          text: string;
          stop: AgentStop;
          /** "Next: …" — a second write the per-turn limit held back. */
          next: string | null;
          results: { tool: string; result: ToolResult }[];
          modelCalls: number;
          usedBackup: boolean;
      }
    | { kind: "not_configured" }
    | { kind: "no_tools" };

/**
 * The model's input: context (attachments, an [EDIT] card) then the user's
 * words. The agent clips the whole thing from the END, so the context is cut
 * here first — the user's own words always survive. Pure.
 */
export function composeUserText(context: string | null, words: string, max = AGENT_LIMITS.userTextMaxChars): string {
    if (!context) return words;
    const room = max - [...words].length - 1;
    if (room <= 0) return words;
    const ctx = [...context];
    const kept = ctx.length <= room ? context : ctx.slice(0, Math.max(room - 1, 0)).join("") + "…";
    return `${kept}\n${words}`;
}

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
    // Paid OpenRouter takes over when the free Gemini key stalls (never in tests).
    const backupModel =
        !opts.model && cfg.openRouterApiKey
            ? createBackupToolCallingModel({ model: cfg.backupModel, apiKey: cfg.openRouterApiKey, tools })
            : null;

    // A history built with other tools is dropped (memory.ts): stale refusals must not replay.
    const toolset = toolsetStamp(tools.map((t) => t.name));
    const history = await loadHistory(user.id, toolset, "whatsapp", now);
    // After an Edit tap, this message is a change to that card.
    const edited = await withEditContext(user, text);
    // E-311 — photos / PDFs / pins sent in the last 15 minutes and not used yet.
    const attachments = pendingMediaContext(await pendingMediaOrNone(user.id));
    const userText = attachments
        ? composeUserText(attachments, edited.trim() || "(no text — only the attachments above)")
        : edited;
    const out = await runAgentTurn(
        {
            system: buildSystemPrompt({ user, now, tools: tools.map((t) => t.name), writesEnabled }),
            history,
            userText,
        },
        { model, backupModel, tools, ctx: { user, messageId: opts.messageId, now, writesEnabled }, logToolCall },
    );
    await saveHistory(user.id, toolset, [...history, ...out.turnMessages]);
    return {
        kind: "ok",
        text: out.text,
        stop: out.stop,
        next: out.next,
        results: out.results,
        modelCalls: out.modelCalls,
        usedBackup: out.usedBackup,
    };
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
