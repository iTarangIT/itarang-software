// Voice-note flags, read per message like the other assistant flags.

import { assistantConfig } from "@/lib/assistant/config";

/**
 * Paid transcriber on OpenRouter. On the 7 real rep notes of 2026-09-28 it got
 * 7/7 in ~1.8 s for $0.0004 a note. gemini-3.6-flash / 3.8-flash were as
 * accurate but took up to 13 s at 2-4x the price; 3.1-flash-lite misheard one.
 */
export const DEFAULT_OPENROUTER_STT_MODEL = "google/gemini-3.5-flash-lite";

export function voiceConfig(env: NodeJS.ProcessEnv = process.env) {
    const core = assistantConfig(env);
    return {
        /** WA_ASSIST_VOICE_DISABLED=true → voice notes get the UC-14 "please type it" reply. */
        disabled: (env.WA_ASSIST_VOICE_DISABLED ?? "").trim().toLowerCase() === "true",
        /** Free direct-Gemini transcriber (the backup). WA_ASSIST_STT_MODEL, default: the agent's own model. */
        model: env.WA_ASSIST_STT_MODEL?.trim() || core.model,
        /** Paid primary transcriber. WA_ASSIST_STT_OPENROUTER_MODEL; no OPENROUTER_API_KEY → skipped. */
        openRouter: core.openRouterApiKey
            ? {
                  apiKey: core.openRouterApiKey,
                  model: env.WA_ASSIST_STT_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_STT_MODEL,
              }
            : null,
    };
}
