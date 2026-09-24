// Assistant core configuration — channel-agnostic flags (see .env.example).
// Read per use, never cached, so a kill-switch change takes effect on the next
// message after the env is reloaded.

export type AssistantConfig = {
    /** OpenAI model id; null = the agent is not switched on. */
    model: string | null;
    openAiKey: string | null;
    /** ASSISTANT_DISABLED=true → one fixed reply to everyone, no model, no data. */
    disabled: boolean;
    /** Pilot allow-list for write tools (users.id). Empty = nobody. */
    writeUserIds: ReadonlySet<string>;
};

export function assistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
    return {
        model: env.ASSISTANT_MODEL?.trim() || null,
        openAiKey: env.OPENAI_API_KEY?.trim() || null,
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
