// Voice-note flags, read per message like the other assistant flags.

import { assistantConfig } from "@/lib/assistant/config";

export function voiceConfig(env: NodeJS.ProcessEnv = process.env) {
    return {
        /** WA_ASSIST_VOICE_DISABLED=true → voice notes get the UC-14 "please type it" reply. */
        disabled: (env.WA_ASSIST_VOICE_DISABLED ?? "").trim().toLowerCase() === "true",
        /** WA_ASSIST_STT_MODEL, default: the agent's own model (same key). */
        model: env.WA_ASSIST_STT_MODEL?.trim() || assistantConfig(env).model,
    };
}
