// Shape of an Assistant tool, and the input pieces the tools share.
//
// Every tool: a Zod input schema (validated again at the boundary, whatever the
// model sent), the acting user from ToolContext (NEVER a model argument), the
// scope predicate, ≤ MAX_TOOL_ROWS rows, and plain JSON out.

import { z } from "zod";
import type { AssistantRole, ToolContext, ToolName, ToolResult } from "../types";
import { findLeadInScope, type ScopedLead } from "../scope";

export type ToolKind = "read" | "write";

export type ToolSpec<S extends z.ZodType = z.ZodType> = {
    name: ToolName;
    kind: ToolKind;
    description: string;
    schema: S;
    run: (ctx: ToolContext, input: z.infer<S>) => Promise<ToolResult>;
};

/**
 * Type-check a tool against ITS schema, then erase the schema type for the
 * registry. Sound because the agent always runs `schema.safeParse` on the
 * model's arguments and passes only `parsed.data` to `run`.
 */
export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec {
    return spec as unknown as ToolSpec;
}

/** Specs whose schema depends on the role (tabs, follow-up shape). */
export type ToolFactory = (role: AssistantRole) => ToolSpec;

export const LeadId = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe("A lead id exactly as returned by an earlier tool result. Never invent or guess one.");

export const NOT_FOUND: ToolResult = { kind: "not_found" };

export const WRITES_OFF: ToolResult = {
    kind: "declined",
    reason: "Saving changes from WhatsApp is not switched on for you yet. Please update the CRM directly.",
};

/**
 * Resolve a lead id inside the user's scope, or produce the result the tool
 * must return instead. Out of scope and nonexistent both yield NOT_FOUND.
 */
export async function scopedLeadOr(
    ctx: ToolContext,
    leadId: string,
): Promise<{ lead: ScopedLead; result?: undefined } | { lead?: undefined; result: ToolResult }> {
    const lead = await findLeadInScope(ctx.user, leadId);
    return lead ? { lead } : { result: NOT_FOUND };
}

/**
 * The gate every write tool runs before proposing anything: pilot flag, scope,
 * ownership. In scope but not owned = read-only (BRD §5). The executor checks
 * all of it again at Confirm time — this is not the only line of defence.
 */
export async function ownedLeadOr(
    ctx: ToolContext,
    leadId: string,
): Promise<{ lead: ScopedLead; result?: undefined } | { lead?: undefined; result: ToolResult }> {
    if (!ctx.writesEnabled) return { result: WRITES_OFF };
    const scoped = await scopedLeadOr(ctx, leadId);
    if (scoped.result) return scoped;
    if (!scoped.lead.owned) {
        return {
            result: {
                kind: "declined",
                reason: scoped.lead.current_owner_id
                    ? "This lead belongs to someone else, so it is read-only for you."
                    : "Nobody owns this lead yet. Claim it first if it is in your pool.",
            },
        };
    }
    return scoped;
}

/** Gate 2 stub answer for a write that passed its checks. Nothing is written. */
export const NOT_YET: ToolResult = {
    kind: "unavailable",
    message: "Saving this from WhatsApp arrives in the next release. Nothing was changed.",
};
