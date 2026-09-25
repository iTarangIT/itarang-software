// Assistant core configuration — channel-agnostic flags (see .env.example).
// Read per use, never cached, so a kill-switch change takes effect on the next
// message after the env is reloaded.

export type AssistantConfig = {
    /** Gemini model id. ASSISTANT_MODEL, default DEFAULT_MODEL (gemini-3.6-flash). */
    model: string;
    /** Google AI Studio key for the agent — WA_ASSIST_GEMINI_API_KEY, shared with nothing else. null = agent off. */
    apiKey: string | null;
    /** ASSISTANT_DISABLED=true → one fixed reply to everyone, no model, no data. */
    disabled: boolean;
    /** Pilot allow-list for write tools (users.id). Empty = nobody. */
    writeUserIds: ReadonlySet<string>;
};

/**
 * gemini-2.5-flash was the pick (2026-09-24), but Google refuses it to new API
 * users ("no longer available to new users") and names gemini-3.6-flash. With
 * thinkingLevel LOW it measured median 2.0 s / max 3.7 s per tool-calling turn
 * (6 runs, sandbox tool schemas), choosing the right tool every time.
 */
export const DEFAULT_MODEL = "gemini-3.6-flash";

export function assistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
    return {
        model: env.ASSISTANT_MODEL?.trim() || DEFAULT_MODEL,
        apiKey: env.WA_ASSIST_GEMINI_API_KEY?.trim() || null,
        disabled: (env.ASSISTANT_DISABLED ?? "").trim().toLowerCase() === "true",
        writeUserIds: new Set(
            (env.ASSISTANT_WRITES_ENABLED_USER_IDS ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    };
}

export function writesEnabledFor(userId: string, cfg: AssistantConfig = assistantConfig()): boolean {
    return cfg.writeUserIds.has(userId);
}

/** CRM base URL for links in replies. Same env the rest of the app uses. */
export function crmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    return (env.NEXT_PUBLIC_APP_URL || env.APP_URL || "https://crm.itarang.com").replace(/\/+$/, "");
}
