// Graph API client for the Sales Assistant number (BRD §2.3-6, §8.2).
//
// Its own env (WA_ASSIST_*), its own sender id, and NO translation: the preview
// a rep confirms is byte-for-byte what will be written. Pure HTTP — logging the
// outbound row is messages.ts's job, so this stays unit-testable.
//
// Retries: only 429, 5xx and network/timeout failures, up to 3 retries with
// jittered exponential backoff. There is no idempotency key in the Graph API,
// so a retried 5xx can double-send; for a text that is harmless, and for a
// preview both copies carry the same action id, which the executor runs once.
//
// WhatsApp limits are asserted here as a last line of defence; render.ts is
// what keeps content inside them.

import type { WaAssistEnv } from "./env";

export const WA_LIMITS = {
    text: 4096,
    interactiveBody: 1024,
    buttons: 3,
    buttonTitle: 20,
    listRows: 10,
    listButton: 20,
    rowTitle: 24,
    rowDescription: 72,
    header: 60,
    replyId: 256,
} as const;

export type SendResult =
    | { ok: true; wamid: string }
    | { ok: false; error: string; status?: number };

export type MediaResult =
    | { ok: true; bytes: Buffer; mimeType: string | null }
    | { ok: false; error: string; status?: number; tooLarge?: boolean };

export type ListRow ={ id: string; title: string; description?: string };

export class WaLimitError extends Error {}

type Deps = {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    timeoutMs?: number;
};

const MAX_RETRIES = 3;

/** Characters as a user sees them (a surrogate pair is one). */
function len(s: string): number {
    return [...s].length;
}

function assertMax(what: string, s: string, max: number) {
    if (len(s) > max) throw new WaLimitError(`${what} is ${len(s)} chars; the WhatsApp limit is ${max}`);
}

export class WaAssistClient {
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly timeoutMs: number;

    constructor(
        private readonly env: Pick<
            WaAssistEnv,
            "WA_ASSIST_PHONE_NUMBER_ID" | "WA_ASSIST_ACCESS_TOKEN" | "WA_ASSIST_GRAPH_VERSION"
        >,
        deps: Deps = {},
    ) {
        this.fetchImpl = deps.fetchImpl ?? fetch;
        this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.random = deps.random ?? Math.random;
        this.timeoutMs = deps.timeoutMs ?? 10_000;
    }

    private get base(): string {
        return `https://graph.facebook.com/${this.env.WA_ASSIST_GRAPH_VERSION}/${this.env.WA_ASSIST_PHONE_NUMBER_ID}`;
    }

    /** "+919876543210" → "919876543210" (Meta wants no '+'). */
    private static to(waPhone: string): string {
        return waPhone.replace(/^\+/, "");
    }

    private async post(path: string, body: Record<string, unknown>): Promise<SendResult> {
        const payload = JSON.stringify({ messaging_product: "whatsapp", ...body });
        let last: SendResult = { ok: false, error: "not attempted" };
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                // 0.5s, 1s, 2s … ×(0.5–1.5) jitter.
                const base = 500 * 2 ** (attempt - 1);
                await this.sleep(Math.round(base * (0.5 + this.random())));
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
            try {
                const res = await this.fetchImpl(`${this.base}/${path}`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.env.WA_ASSIST_ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    body: payload,
                    signal: ctrl.signal,
                });
                const json = (await res.json().catch(() => null)) as {
                    messages?: { id?: string }[];
                    success?: boolean;
                    error?: { message?: string; code?: number };
                } | null;
                if (res.ok) {
                    const wamid = json?.messages?.[0]?.id;
                    if (wamid) return { ok: true, wamid };
                    // markRead answers { success: true } with no message id.
                    if (json?.success) return { ok: true, wamid: "" };
                    return { ok: false, error: "Graph API returned no message id", status: res.status };
                }
                last = {
                    ok: false,
                    status: res.status,
                    error: json?.error?.message ?? `HTTP ${res.status}`,
                };
                if (res.status !== 429 && res.status < 500) return last;
            } catch (err) {
                last = { ok: false, error: err instanceof Error ? err.message : String(err) };
            } finally {
                clearTimeout(timer);
            }
        }
        return last;
    }

    async sendText(waPhone: string, body: string): Promise<SendResult> {
        assertMax("text", body, WA_LIMITS.text);
        return this.post("messages", {
            to: WaAssistClient.to(waPhone),
            type: "text",
            text: { preview_url: false, body },
        });
    }

    async sendButtons(
        waPhone: string,
        body: string,
        buttons: { id: string; title: string }[],
    ): Promise<SendResult> {
        assertMax("interactive body", body, WA_LIMITS.interactiveBody);
        if (buttons.length === 0 || buttons.length > WA_LIMITS.buttons) {
            throw new WaLimitError(`${buttons.length} buttons; WhatsApp allows 1–${WA_LIMITS.buttons}`);
        }
        for (const b of buttons) {
            assertMax("button title", b.title, WA_LIMITS.buttonTitle);
            assertMax("button id", b.id, WA_LIMITS.replyId);
        }
        return this.post("messages", {
            to: WaAssistClient.to(waPhone),
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: body },
                action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
            },
        });
    }

    async sendList(
        waPhone: string,
        list: { body: string; button: string; rows: ListRow[]; header?: string },
    ): Promise<SendResult> {
        assertMax("interactive body", list.body, WA_LIMITS.interactiveBody);
        assertMax("list button", list.button, WA_LIMITS.listButton);
        if (list.header) assertMax("header", list.header, WA_LIMITS.header);
        if (list.rows.length === 0 || list.rows.length > WA_LIMITS.listRows) {
            throw new WaLimitError(`${list.rows.length} rows; WhatsApp allows 1–${WA_LIMITS.listRows}`);
        }
        for (const r of list.rows) {
            assertMax("row title", r.title, WA_LIMITS.rowTitle);
            if (r.description) assertMax("row description", r.description, WA_LIMITS.rowDescription);
            assertMax("row id", r.id, WA_LIMITS.replyId);
        }
        return this.post("messages", {
            to: WaAssistClient.to(waPhone),
            type: "interactive",
            interactive: {
                type: "list",
                ...(list.header ? { header: { type: "text", text: list.header } } : {}),
                body: { text: list.body },
                action: { button: list.button, sections: [{ title: "Leads", rows: list.rows }] },
            },
        });
    }

    /**
     * An inbound media file (a voice note) by its Meta media id: resolve the
     * short-lived URL, then fetch the bytes, both with the Assistant's own
     * token. Anything over `maxBytes` is refused before and after the download.
     * Retries like post(): 429, 5xx and network/timeout only. Never throws.
     */
    async downloadMedia(mediaId: string, maxBytes: number): Promise<MediaResult> {
        const meta = await this.getWithRetry(
            `https://graph.facebook.com/${this.env.WA_ASSIST_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`,
        );
        if (!meta.ok) return meta;
        const info = (await meta.res.json().catch(() => null)) as {
            url?: string;
            mime_type?: string;
            file_size?: number | string;
        } | null;
        if (!info?.url) return { ok: false, error: "Graph API returned no media url" };
        const declared = Number(info.file_size);
        if (Number.isFinite(declared) && declared > maxBytes) {
            return { ok: false, error: `media is ${declared} bytes; the limit is ${maxBytes}`, tooLarge: true };
        }
        const file = await this.getWithRetry(info.url);
        if (!file.ok) return file;
        const bytes = Buffer.from(await file.res.arrayBuffer());
        if (bytes.length > maxBytes) {
            return { ok: false, error: `media is ${bytes.length} bytes; the limit is ${maxBytes}`, tooLarge: true };
        }
        if (bytes.length === 0) return { ok: false, error: "media is empty" };
        return { ok: true, bytes, mimeType: info.mime_type ?? file.res.headers.get("content-type") ?? null };
    }

    private async getWithRetry(
        url: string,
    ): Promise<{ ok: true; res: Response } | { ok: false; error: string; status?: number }> {
        let last: { ok: false; error: string; status?: number } = { ok: false, error: "not attempted" };
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const base = 500 * 2 ** (attempt - 1);
                await this.sleep(Math.round(base * (0.5 + this.random())));
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
            try {
                const res = await this.fetchImpl(url, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${this.env.WA_ASSIST_ACCESS_TOKEN}` },
                    signal: ctrl.signal,
                });
                if (res.ok) {
                    // Read the body inside the timeout window.
                    const buf = await res.arrayBuffer();
                    return { ok: true, res: new Response(buf, { status: res.status, headers: res.headers }) };
                }
                const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                last = { ok: false, status: res.status, error: json?.error?.message ?? `HTTP ${res.status}` };
                if (res.status !== 429 && res.status < 500) return last;
            } catch (err) {
                last = { ok: false, error: err instanceof Error ? err.message : String(err) };
            } finally {
                clearTimeout(timer);
            }
        }
        return last;
    }

    /** Blue ticks on an inbound message. Best-effort; never retried beyond post(). */
    async markRead(providerMessageId: string): Promise<SendResult> {
        return this.post("messages", { status: "read", message_id: providerMessageId });
    }
}
