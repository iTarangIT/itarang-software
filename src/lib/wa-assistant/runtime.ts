// Production wiring for the router: real DB, real Graph client, the real
// agent, the log. Kept apart from router.ts so the router's decisions are
// tested with fakes.

import { log } from "@/lib/log";
import { assistantConfig } from "@/lib/assistant/config";
import { hasOpenPendingAction, setActionMessageId } from "@/lib/assistant/actions";
import { cancelAction, executeAction } from "@/lib/assistant/executor";
import { agentTurn, runToolDirect } from "@/lib/assistant/turn";
import type { WaAssistEnv } from "./env";
import { WaAssistClient } from "./client";
import { resolveSender } from "./identity";
import { verifyLinkCode } from "./link";
import { withUserLease } from "./lock";
import { markHandled, recordOutbound } from "./messages";
import { renderLeadCard, renderPreview, renderTapOutcome, renderTurn, type WaPayload } from "./render";
import type { RouterDeps } from "./router";
import type { AssistantUser } from "@/lib/assistant/types";

const LEAD_NOT_FOUND = "I couldn't find that lead.";

/** A "Send invite" tap: run invite_dealer_onboarding directly (no model) → its preview, or why not. */
export async function proposeInvitePayload(user: AssistantUser, leadId: string, messageRowId: string): Promise<WaPayload> {
    const r = await runToolDirect(user, "invite_dealer_onboarding", { lead_id: leadId }, { messageId: messageRowId });
    if (r.kind === "preview") return renderPreview(r.preview, r.action_id);
    if (r.kind === "declined") return { kind: "text", body: r.reason };
    return { kind: "text", body: LEAD_NOT_FOUND };
}

export function defaultRouterDeps(env: WaAssistEnv): RouterDeps {
    const client = new WaAssistClient(env);
    const logFn: RouterDeps["log"] = (level, msg, meta) => log[level](msg, meta);

    const sendPayload: RouterDeps["sendPayload"] = async (waPhone, payload, userId) => {
        try {
            const res =
                payload.kind === "list"
                    ? await client.sendList(waPhone, {
                          body: payload.body,
                          button: payload.button,
                          header: payload.header,
                          rows: payload.rows,
                      })
                    : payload.kind === "buttons"
                      ? await client.sendButtons(waPhone, payload.body, payload.buttons)
                      : await client.sendText(waPhone, payload.body);
            const actionId = payload.kind === "buttons" ? (payload.actionId ?? null) : null;
            await recordOutbound({
                waPhone,
                userId,
                type: payload.kind,
                text: payload.body,
                wamid: res.ok ? res.wamid : null,
                error: res.ok ? null : res.error,
                actionId,
                raw:
                    payload.kind === "list"
                        ? { rows: payload.rows.map((r) => r.id) }
                        : payload.kind === "buttons"
                          ? { buttons: payload.buttons.map((b) => b.id) }
                          : null,
            });
            if (actionId && res.ok) await setActionMessageId(actionId, res.wamid);
            if (!res.ok) logFn("error", "[wa-assist] send failed", { status: res.status, error: res.error });
        } catch (err) {
            logFn("error", "[wa-assist] reply failed", {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    return {
        verifyLink: ({ waPhone, code, messageRowId }) =>
            verifyLinkCode({ waPhone, code, messageRowId, secret: env.WA_ASSIST_APP_SECRET }),
        resolveSender,
        markHandled,
        replyText: (waPhone, text, userId) => sendPayload(waPhone, { kind: "text", body: text }, userId),
        sendPayload,
        openLead: async (user, leadId, messageRowId): Promise<WaPayload> => {
            const result = await runToolDirect(user, "get_lead_details", { lead_id: leadId }, { messageId: messageRowId });
            return {
                kind: "text",
                body: result.kind === "lead" ? renderLeadCard(result.lead) : LEAD_NOT_FOUND,
            };
        },
        proposeInvite: proposeInvitePayload,
        confirmAction: async (user, actionId, messageRowId) =>
            renderTapOutcome(await executeAction(actionId, user, { messageId: messageRowId })),
        cancelAction: async (user, actionId) => renderTapOutcome(await cancelAction(actionId, user)),
        isDisabled: () => assistantConfig().disabled,
        hasPendingAction: hasOpenPendingAction,
        runTextTurn: async (user, text, messageRowId) => {
            const leased = await withUserLease(user.id, () => agentTurn(user, text, { messageId: messageRowId }));
            if (!leased.ok) return { kind: "busy" };
            const r = leased.value;
            if (r.kind === "ok") {
                return {
                    kind: "ok",
                    payload: renderTurn(r),
                    modelCalls: r.modelCalls,
                    toolCalls: r.results.length,
                };
            }
            // no_tools cannot follow a resolved asm/ISR identity; treat as misconfiguration.
            return { kind: "not_configured" };
        },
        log: logFn,
    };
}
