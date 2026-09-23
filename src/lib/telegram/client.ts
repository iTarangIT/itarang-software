/**
 * Minimal Telegram Bot API client — one POST, no SDK.
 *
 * Only what the 08:00 Fleet Monitor send needs: a photo with a caption, or a
 * plain message when there is no photo worth sending. Adding a dependency for
 * two endpoints would be more code to audit than the two endpoints.
 *
 * CONFIG comes from the environment and is never logged. On production the env
 * is rewritten from the PROD_ENV_FILE_B64 secret on EVERY deploy, so these two
 * values must live in that secret as well as in the box's shared/.env — a value
 * set only on the box disappears at the next deploy.
 */

const API = "https://api.telegram.org";

/** Telegram errors carry a useful `description`; surface it, never the token. */
class TelegramError extends Error {
    constructor(
        method: string,
        readonly status: number,
        description: string,
    ) {
        super(`telegram ${method} failed (${status}): ${description}`);
        this.name = "TelegramError";
    }
}

export type TelegramConfig = { token: string; chatId: string };

/**
 * Returns null when the integration is not configured, rather than throwing.
 * The caller treats "no token" as "this box does not send" — which is the
 * normal state on a developer machine and on sandbox.
 */
export function telegramConfig(): TelegramConfig | null {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return null;
    return { token, chatId };
}

async function call(
    cfg: TelegramConfig,
    method: string,
    body: FormData | URLSearchParams,
): Promise<{ messageId: number }> {
    const res = await fetch(`${API}/bot${cfg.token}/${method}`, { method: "POST", body });

    // Parse before checking res.ok: Telegram returns its `description` on 4xx,
    // and that string is the only thing that says WHY (bad chat id, bot not in
    // the group, caption too long).
    const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
    } | null;

    if (!res.ok || !payload?.ok) {
        throw new TelegramError(method, res.status, payload?.description ?? "no description");
    }
    return { messageId: payload.result?.message_id ?? 0 };
}

export async function sendPhoto(
    cfg: TelegramConfig,
    photo: Buffer,
    caption: string,
    filename = "fleet-monitor.png",
): Promise<{ messageId: number }> {
    const form = new FormData();
    form.append("chat_id", cfg.chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append(
        "photo",
        new Blob([new Uint8Array(photo)], { type: "image/png" }),
        filename,
    );
    return call(cfg, "sendPhoto", form);
}

export async function sendMessage(
    cfg: TelegramConfig,
    text: string,
): Promise<{ messageId: number }> {
    return call(
        cfg,
        "sendMessage",
        new URLSearchParams({
            chat_id: cfg.chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: "true",
        }),
    );
}
