// Meta WhatsApp Cloud API webhook payload → typed events, Zod-validated.
//
// Every event carries the phone_number_id it was addressed to (from the
// change's metadata), so the route can drop anything that is not the
// Assistant's number (BRD §8.6 "each webhook drops events for the other's").
//
// A button/list tap is ONLY ever `interactive` with a `replyId` taken from
// Meta's interactive.button_reply / list_reply object. Typed text that happens
// to look like "ast:c:…" stays `text` — the executor is reachable from a real
// tap and nothing else (Invariant 2).

import { z } from "zod";

const Phone = z.string().regex(/^\d{8,15}$/);

const InteractiveSchema = z.object({
    type: z.string(),
    button_reply: z.object({ id: z.string().max(256), title: z.string().optional() }).optional(),
    list_reply: z.object({ id: z.string().max(256), title: z.string().optional() }).optional(),
});

const MessageSchema = z.object({
    id: z.string().min(1).max(256),
    from: Phone,
    timestamp: z.string().optional(),
    type: z.string().min(1),
    text: z.object({ body: z.string() }).optional(),
    interactive: InteractiveSchema.optional(),
});

const StatusSchema = z.object({
    id: z.string().min(1).max(256),
    status: z.string().min(1),
    recipient_id: z.string().optional(),
    errors: z.array(z.unknown()).optional(),
});

const ChangeSchema = z.object({
    field: z.string().optional(),
    value: z.object({
        metadata: z.object({ phone_number_id: z.string().min(1) }),
        messages: z.array(z.unknown()).optional(),
        statuses: z.array(z.unknown()).optional(),
    }),
});

const EnvelopeSchema = z.object({
    object: z.literal("whatsapp_business_account"),
    entry: z.array(z.object({ changes: z.array(z.unknown()).default([]) })),
});

/** Media and other non-text kinds get the fixed UC-14 reply; counted by type. */
export const MEDIA_TYPES = ["audio", "image", "document", "sticker", "video", "location", "contacts"] as const;

export type InboundMessage = {
    kind: "message";
    phoneNumberId: string;
    providerMessageId: string;
    /** Sender in E.164 WITH the leading '+', from Meta — never from message text. */
    waPhone: string;
    /** Meta's type, or "unsupported" when the object failed validation. */
    type: string;
    /** Body for `text`; the tapped title for `interactive` (display/log only). */
    text: string | null;
    /** Only for a genuine interactive button/list reply. */
    replyId: string | null;
    raw: unknown;
};

export type StatusEvent = {
    kind: "status";
    phoneNumberId: string;
    /** The OUTBOUND message's wamid. */
    providerMessageId: string;
    status: string;
    raw: unknown;
};

export type WebhookEvent = InboundMessage | StatusEvent;

export type ParseResult =
    | { ok: true; events: WebhookEvent[]; skipped: number }
    | { ok: false; error: string };

export function toE164(metaPhone: string): string {
    return `+${metaPhone}`;
}

function parseMessage(phoneNumberId: string, raw: unknown): InboundMessage | null {
    const m = MessageSchema.safeParse(raw);
    if (!m.success) {
        // Keep the event if it has an id and sender — it is still an inbound
        // message that must be deduped, logged and answered — but treat its
        // content as unsupported rather than trusting any of it.
        const loose = z.object({ id: z.string().min(1).max(256), from: Phone }).safeParse(raw);
        if (!loose.success) return null;
        return {
            kind: "message",
            phoneNumberId,
            providerMessageId: loose.data.id,
            waPhone: toE164(loose.data.from),
            type: "unsupported",
            text: null,
            replyId: null,
            raw,
        };
    }
    const msg = m.data;
    let text: string | null = null;
    let replyId: string | null = null;
    if (msg.type === "text") {
        text = msg.text?.body ?? "";
    } else if (msg.type === "interactive") {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        replyId = reply?.id ?? null;
        text = reply?.title ?? null;
    }
    return {
        kind: "message",
        phoneNumberId,
        providerMessageId: msg.id,
        waPhone: toE164(msg.from),
        type: msg.type,
        text,
        replyId,
        raw,
    };
}

export function parseWebhook(rawBody: string): ParseResult {
    let json: unknown;
    try {
        json = JSON.parse(rawBody);
    } catch {
        return { ok: false, error: "invalid JSON" };
    }
    const env = EnvelopeSchema.safeParse(json);
    if (!env.success) return { ok: false, error: "not a whatsapp_business_account payload" };

    const events: WebhookEvent[] = [];
    let skipped = 0;
    for (const entry of env.data.entry) {
        for (const rawChange of entry.changes) {
            const change = ChangeSchema.safeParse(rawChange);
            if (!change.success) {
                skipped++;
                continue;
            }
            const { metadata, messages = [], statuses = [] } = change.data.value;
            for (const rawStatus of statuses) {
                const s = StatusSchema.safeParse(rawStatus);
                if (!s.success) {
                    skipped++;
                    continue;
                }
                events.push({
                    kind: "status",
                    phoneNumberId: metadata.phone_number_id,
                    providerMessageId: s.data.id,
                    status: s.data.status,
                    raw: rawStatus,
                });
            }
            for (const rawMsg of messages) {
                const msg = parseMessage(metadata.phone_number_id, rawMsg);
                if (msg) events.push(msg);
                else skipped++;
            }
        }
    }
    return { ok: true, events, skipped };
}
