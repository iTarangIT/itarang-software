// WhatsApp channel configuration for the Sales Assistant (BRD §7 Secrets).
//
// Its OWN env names — never META_WA_*. The values are the same token and app
// secret as the dealer bot today (same Meta app/WABA), loaded under new names so
// the two flows can be split later without a code change.
//
// Validated on use, not at module load: `next build` imports route modules with
// NODE_ENV=production and CI has no WA_ASSIST_*, so a load-time throw would fail
// every build. instrumentation-node.ts reports a misconfiguration at boot; the
// webhook fails closed (503) until it is fixed.

import { z } from "zod";

const Schema = z.object({
    WA_ASSIST_PHONE_NUMBER_ID: z.string().regex(/^\d{5,20}$/, "numeric Meta phone_number_id"),
    WA_ASSIST_ACCESS_TOKEN: z.string().min(20),
    WA_ASSIST_APP_SECRET: z.string().min(16),
    WA_ASSIST_VERIFY_TOKEN: z.string().min(8),
    WA_ASSIST_GRAPH_VERSION: z
        .string()
        .regex(/^v\d+\.\d+$/, "like v21.0")
        .default("v21.0"),
    /** Display only: the number shown on the Link WhatsApp page. */
    WA_ASSIST_DISPLAY_NUMBER: z.string().optional(),
});

export type WaAssistEnv = z.infer<typeof Schema>;

export type WaAssistEnvResult =
    | { ok: true; env: WaAssistEnv }
    | { ok: false; problems: string[] };

/** Never throws; `problems` names the variables (never their values). */
export function readWaAssistEnv(source: NodeJS.ProcessEnv = process.env): WaAssistEnvResult {
    const parsed = Schema.safeParse({
        WA_ASSIST_PHONE_NUMBER_ID: source.WA_ASSIST_PHONE_NUMBER_ID || undefined,
        WA_ASSIST_ACCESS_TOKEN: source.WA_ASSIST_ACCESS_TOKEN || undefined,
        WA_ASSIST_APP_SECRET: source.WA_ASSIST_APP_SECRET || undefined,
        WA_ASSIST_VERIFY_TOKEN: source.WA_ASSIST_VERIFY_TOKEN || undefined,
        WA_ASSIST_GRAPH_VERSION: source.WA_ASSIST_GRAPH_VERSION || undefined,
        WA_ASSIST_DISPLAY_NUMBER: source.WA_ASSIST_DISPLAY_NUMBER || undefined,
    });
    if (parsed.success) return { ok: true, env: parsed.data };
    return {
        ok: false,
        problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
}

export class WaAssistConfigError extends Error {
    constructor(problems: string[]) {
        super(`WhatsApp Assistant is not configured: ${problems.join("; ")}`);
    }
}

/** Throws WaAssistConfigError when misconfigured. */
export function waAssistEnv(source: NodeJS.ProcessEnv = process.env): WaAssistEnv {
    const r = readWaAssistEnv(source);
    if (!r.ok) throw new WaAssistConfigError(r.problems);
    return r.env;
}
