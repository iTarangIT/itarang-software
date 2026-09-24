// Production wiring for the router: real DB, real Graph client, the log.
// Kept apart from router.ts so the router's decisions are tested with fakes.

import { log } from "@/lib/log";
import type { WaAssistEnv } from "./env";
import { WaAssistClient } from "./client";
import { resolveSender } from "./identity";
import { verifyLinkCode } from "./link";
import { markHandled, recordOutbound } from "./messages";
import type { RouterDeps } from "./router";

export function defaultRouterDeps(env: WaAssistEnv): RouterDeps {
    const client = new WaAssistClient(env);
    const logFn: RouterDeps["log"] = (level, msg, meta) => log[level](msg, meta);

    return {
        verifyLink: ({ waPhone, code, messageRowId }) =>
            verifyLinkCode({ waPhone, code, messageRowId, secret: env.WA_ASSIST_APP_SECRET }),
        resolveSender,
        markHandled,
        replyText: async (waPhone, text, userId) => {
            try {
                const res = await client.sendText(waPhone, text);
                await recordOutbound({
                    waPhone,
                    userId,
                    type: "text",
                    text,
                    wamid: res.ok ? res.wamid : null,
                    error: res.ok ? null : res.error,
                });
                if (!res.ok) logFn("error", "[wa-assist] send failed", { status: res.status, error: res.error });
            } catch (err) {
                logFn("error", "[wa-assist] reply failed", {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        log: logFn,
    };
}
