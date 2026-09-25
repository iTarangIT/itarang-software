// Production wiring for the router: real DB, real Graph client, the real
// agent, the log. Kept apart from router.ts so the router's decisions are
// tested with fakes.

import { log } from "@/lib/log";
import { assistantConfig } from "@/lib/assistant/config";
import { hasOpenPendingAction } from "@/lib/assistant/actions";
import { agentTurn, runToolDirect } from "@/lib/assistant/turn";
import type { WaAssistEnv } from "./env";
import { WaAssistClient } from "./client";
import { resolveSender } from "./identity";
import { verifyLinkCode } from "./link";
import { withUserLease } from "./lock";
import { markHandled, recordOutbound } from "./messages";
import { renderLeadCard, renderTurn, type WaPayload } from "./render";
import type { RouterDeps } from "./router";

const LEAD_NOT_FOUND = "I couldn't find that lead.";

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
                    : await client.sendText(waPhone, payload.body);
            await recordOutbound({
                waPhone,
                userId,
                type: payload.kind === "list" ? "list" : "text",
                text: payload.body,
                wamid: res.ok ? res.wamid : null,
                error: res.ok ? null : res.error,
                raw: payload.kind === "list" ? { rows: payload.rows.map((r) => r.id) } : null,
            });
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
