import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readWaAssistEnv, waAssistEnv, WaAssistConfigError } from "../env";
import { verifyHandshake, verifySignature } from "../verify";
import { parseWebhook } from "../parse";
import { WaAssistClient, WaLimitError } from "../client";

const SECRET = "test-app-secret-0123456789";
const sign = (body: string, secret = SECRET) =>
    "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

const GOOD_ENV = {
    WA_ASSIST_PHONE_NUMBER_ID: "123456789012345",
    WA_ASSIST_ACCESS_TOKEN: "EAAG-test-token-abcdefghij",
    WA_ASSIST_APP_SECRET: SECRET,
    WA_ASSIST_VERIFY_TOKEN: "verify-me-please",
} as unknown as NodeJS.ProcessEnv;

describe("env", () => {
    it("parses and defaults the Graph version", () => {
        const r = readWaAssistEnv(GOOD_ENV);
        expect(r.ok && r.env.WA_ASSIST_GRAPH_VERSION).toBe("v21.0");
    });

    it("names what is missing, never the values, and never reads META_WA_*", () => {
        const r = readWaAssistEnv({ META_WA_ACCESS_TOKEN: "x".repeat(40) } as unknown as NodeJS.ProcessEnv);
        expect(r.ok).toBe(false);
        const problems = r.ok ? [] : r.problems;
        expect(problems.join()).toContain("WA_ASSIST_ACCESS_TOKEN");
        expect(problems.join()).not.toContain("xxxx");
        expect(() => waAssistEnv({} as NodeJS.ProcessEnv)).toThrow(WaAssistConfigError);
    });
});

describe("verifySignature (x-hub-signature-256)", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';

    it("accepts a correct signature over the raw body", () => {
        expect(verifySignature(body, sign(body), SECRET)).toBe(true);
    });

    it("rejects a wrong secret, a tampered body, a missing / malformed header, an empty secret", () => {
        expect(verifySignature(body, sign(body, "other-secret-000000"), SECRET)).toBe(false);
        expect(verifySignature(body + " ", sign(body), SECRET)).toBe(false);
        expect(verifySignature(body, null, SECRET)).toBe(false);
        expect(verifySignature(body, "sha256=abc", SECRET)).toBe(false);
        expect(verifySignature(body, sign(body).replace("sha256=", "sha1="), SECRET)).toBe(false);
        expect(verifySignature(body, sign(body), "")).toBe(false);
    });

    it("is byte-exact for non-ASCII bodies", () => {
        const hindi = '{"t":"नमस्ते ₹"}';
        expect(verifySignature(hindi, sign(hindi), SECRET)).toBe(true);
    });
});

describe("verifyHandshake", () => {
    const url = (q: string) => new URL(`https://x/api/assistant/wa/webhook?${q}`);
    it("echoes the challenge only for mode=subscribe and the right token", () => {
        expect(verifyHandshake(url("hub.mode=subscribe&hub.verify_token=tok123456&hub.challenge=42"), "tok123456")).toBe("42");
        expect(verifyHandshake(url("hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"), "tok123456")).toBeNull();
        expect(verifyHandshake(url("hub.mode=other&hub.verify_token=tok123456&hub.challenge=42"), "tok123456")).toBeNull();
        expect(verifyHandshake(url("hub.mode=subscribe&hub.verify_token=&hub.challenge=42"), "")).toBeNull();
    });
});

const payload = (value: Record<string, unknown>, phoneNumberId = "123456789012345") =>
    JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
    });

describe("parseWebhook", () => {
    it("text: sender comes from Meta's `from`, normalised to E.164", () => {
        const r = parseWebhook(payload({ messages: [{ id: "wamid.1", from: "919876543210", type: "text", text: { body: "Aaj ka schedule?" } }] }));
        expect(r).toMatchObject({
            ok: true,
            events: [{ kind: "message", type: "text", waPhone: "+919876543210", text: "Aaj ka schedule?", replyId: null, phoneNumberId: "123456789012345" }],
        });
    });

    it("button_reply and list_reply carry replyId; typed 'ast:c:…' text does NOT", () => {
        const r = parseWebhook(payload({
            messages: [
                { id: "a", from: "919876543210", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "ast:c:abc", title: "Confirm" } } },
                { id: "b", from: "919876543210", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "ast:lead:DL-1", title: "ABC Traders" } } },
                { id: "c", from: "919876543210", type: "text", text: { body: "ast:c:abc" } },
            ],
        }));
        if (!r.ok) throw new Error(r.error);
        expect(r.events.map((e) => e.kind === "message" && [e.type, e.replyId])).toEqual([
            ["interactive", "ast:c:abc"],
            ["interactive", "ast:lead:DL-1"],
            ["text", null],
        ]);
    });

    it("media types pass through with their type; statuses are separate events", () => {
        const r = parseWebhook(payload({
            messages: [
                { id: "v", from: "919876543210", type: "audio", audio: { id: "m" } },
                { id: "s", from: "919876543210", type: "sticker", sticker: { id: "m" } },
            ],
            statuses: [{ id: "wamid.out", status: "delivered", recipient_id: "919876543210" }],
        }));
        if (!r.ok) throw new Error(r.error);
        expect(r.events.map((e) => (e.kind === "status" ? `status:${e.status}` : e.type))).toEqual([
            "status:delivered", "audio", "sticker",
        ]);
    });

    it("a malformed message with an id + sender is kept as 'unsupported'; without them it is skipped", () => {
        const r = parseWebhook(payload({
            messages: [
                { id: "x", from: "919876543210", type: 42 },
                { from: "919876543210", type: "text" },
                { id: "y", from: "not-a-phone", type: "text", text: { body: "hi" } },
            ],
        }));
        if (!r.ok) throw new Error(r.error);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ providerMessageId: "x", type: "unsupported", text: null, replyId: null });
        expect(r.skipped).toBe(2);
    });

    it("rejects non-JSON and non-WABA payloads; skips a change with no metadata", () => {
        expect(parseWebhook("nope").ok).toBe(false);
        expect(parseWebhook(JSON.stringify({ object: "page", entry: [] })).ok).toBe(false);
        const r = parseWebhook(JSON.stringify({
            object: "whatsapp_business_account",
            entry: [{ changes: [{ value: { messages: [{ id: "z", from: "919876543210", type: "text", text: { body: "x" } }] } }] }],
        }));
        expect(r).toEqual({ ok: true, events: [], skipped: 1 });
    });
});

function fakeFetch(responses: { status: number; json?: unknown }[] | Error) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let i = 0;
    const fn = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        if (responses instanceof Error) throw responses;
        const r = responses[Math.min(i++, responses.length - 1)];
        return { ok: r.status < 300, status: r.status, json: async () => r.json } as Response;
    });
    return { fn, calls };
}

const clientEnv = {
    WA_ASSIST_PHONE_NUMBER_ID: "123456789012345",
    WA_ASSIST_ACCESS_TOKEN: "EAAG-test-token-abcdefghij",
    WA_ASSIST_GRAPH_VERSION: "v21.0",
};
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("WaAssistClient", () => {
    it("sends from the assistant's own number, no '+', no translation layer", async () => {
        const { fn, calls } = fakeFetch([{ status: 200, json: { messages: [{ id: "wamid.OUT" }] } }]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        expect(await c.sendText("+919876543210", "Aaj ka schedule")).toEqual({ ok: true, wamid: "wamid.OUT" });
        expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/123456789012345/messages");
        expect(calls[0].body).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", text: { body: "Aaj ka schedule" } });
    });

    it("retries 429/5xx up to 3 times, then gives up", async () => {
        const { fn } = fakeFetch([{ status: 503 }, { status: 429 }, { status: 500 }, { status: 502 }, { status: 200, json: { messages: [{ id: "late" }] } }]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        const r = await c.sendText("+919876543210", "x");
        expect(r).toMatchObject({ ok: false, status: 502 });
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it("succeeds on a retry after a 5xx", async () => {
        const { fn } = fakeFetch([{ status: 500 }, { status: 200, json: { messages: [{ id: "w2" }] } }]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        expect(await c.sendText("+919876543210", "x")).toEqual({ ok: true, wamid: "w2" });
    });

    it("does not retry a 4xx", async () => {
        const { fn } = fakeFetch([{ status: 400, json: { error: { message: "bad" } } }]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        expect(await c.sendText("+919876543210", "x")).toEqual({ ok: false, status: 400, error: "bad" });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries network errors", async () => {
        const { fn } = fakeFetch(new Error("ECONNRESET"));
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        expect(await c.sendText("+919876543210", "x")).toEqual({ ok: false, error: "ECONNRESET" });
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it("asserts WhatsApp limits (counting emoji as one character)", async () => {
        const { fn } = fakeFetch([{ status: 200, json: { messages: [{ id: "w" }] } }]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        await expect(c.sendButtons("+91", "b", [{ id: "1", title: "x".repeat(21) }])).rejects.toThrow(WaLimitError);
        await expect(c.sendButtons("+91", "b", [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: "t" })))).rejects.toThrow(WaLimitError);
        await expect(c.sendList("+91", { body: "b", button: "View", rows: [] })).rejects.toThrow(WaLimitError);
        await expect(
            c.sendList("+91", { body: "b", button: "View", rows: [{ id: "r", title: "🙂".repeat(24) }] }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
            c.sendList("+91", { body: "b", button: "View", rows: [{ id: "r", title: "🙂".repeat(25) }] }),
        ).rejects.toThrow(WaLimitError);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});


describe("voice notes: parse + downloadMedia", () => {
    it("parseWebhook carries a voice note's media id and mime type, and nothing for other types", () => {
        const r = parseWebhook(payload({
            messages: [
                { id: "v", from: "919876543210", type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", voice: true } },
                { id: "t", from: "919876543210", type: "text", text: { body: "hi" } },
            ],
        }));
        if (!r.ok) throw new Error(r.error);
        const [v, t] = r.events;
        expect(v.kind === "message" && v.audio).toEqual({ id: "MEDIA1", mimeType: "audio/ogg; codecs=opus" });
        expect(t.kind === "message" && t.audio).toBeNull();
    });

    function mediaFetch(steps: (Response | Error)[]) {
        const urls: string[] = [];
        const auth: (string | null)[] = [];
        let i = 0;
        const fn = vi.fn(async (url: string, init: RequestInit) => {
            urls.push(url);
            auth.push(new Headers(init.headers).get("authorization"));
            const step = steps[Math.min(i++, steps.length - 1)];
            if (step instanceof Error) throw step;
            return step;
        });
        return { fn, urls, auth };
    }
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("resolves the media url, then downloads it — both with the assistant's own token", async () => {
        const { fn, urls, auth } = mediaFetch([
            json({ url: "https://lookaside.fbsbx.com/x", mime_type: "audio/ogg", file_size: 4 }),
            new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
        ]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        const r = await c.downloadMedia("MEDIA1", 1000);
        expect(r.ok && [...r.bytes]).toEqual([1, 2, 3, 4]);
        expect(r.ok && r.mimeType).toBe("audio/ogg");
        expect(urls).toEqual(["https://graph.facebook.com/v21.0/MEDIA1", "https://lookaside.fbsbx.com/x"]);
        expect(auth).toEqual(["Bearer EAAG-test-token-abcdefghij", "Bearer EAAG-test-token-abcdefghij"]);
    });

    it("refuses an oversize file before downloading it", async () => {
        const { fn } = mediaFetch([json({ url: "https://lookaside.fbsbx.com/x", file_size: 5000 })]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        const r = await c.downloadMedia("M", 1000);
        expect(r).toMatchObject({ ok: false, tooLarge: true });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries a 5xx, not a 404", async () => {
        const a = mediaFetch([
            json({ error: { message: "boom" } }, 503),
            json({ url: "https://lookaside.fbsbx.com/x" }),
            new Response(new Uint8Array([9]), { status: 200 }),
        ]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: a.fn as unknown as typeof fetch, ...noSleep });
        expect((await c.downloadMedia("M", 1000)).ok).toBe(true);
        expect(a.fn).toHaveBeenCalledTimes(3);

        const b = mediaFetch([json({ error: { message: "Unsupported get request" } }, 404)]);
        const d = new WaAssistClient(clientEnv, { fetchImpl: b.fn as unknown as typeof fetch, ...noSleep });
        expect(await d.downloadMedia("M", 1000)).toEqual({ ok: false, status: 404, error: "Unsupported get request" });
        expect(b.fn).toHaveBeenCalledTimes(1);
    });

    it("a network failure on every attempt is an error result, never a throw", async () => {
        const { fn } = mediaFetch([new Error("fetch failed")]);
        const c = new WaAssistClient(clientEnv, { fetchImpl: fn as unknown as typeof fetch, ...noSleep });
        expect(await c.downloadMedia("M", 1000)).toEqual({ ok: false, error: "fetch failed" });
        expect(fn).toHaveBeenCalledTimes(4);
    });
});
