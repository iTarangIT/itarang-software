// The Assistant's own WhatsApp message log (assistant_wa_messages) — never the
// dealer bot's whatsapp_messages.
//
//   insertInbound   the dedupe: UNIQUE provider_message_id, ON CONFLICT DO
//                   NOTHING. Runs BEFORE the webhook answers 200 (plan D1), so a
//                   restart after the 200 still leaves a row to find.
//   markHandled     what the router did with it — the audit trail (Invariant 9)
//                   and the LINK lock-out counter.
//   applyStatus     sent → delivered → read on OUR outbound row, never backwards;
//                   `failed` always lands. Receipts are not deduped: several
//                   share one wamid by design.
//   recordOutbound  every reply, with its wamid or its send error.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantWaMessages } from "@/lib/db/schema";
import type { InboundMessage } from "./parse";

/** What the router did with an inbound message. */
export const HANDLING = [
    "link_ok",
    "link_failed",
    "link_locked",
    "link_ineligible",
    "unlinked",
    "disabled",
    "tap_confirm",
    "tap_cancel",
    "tap_lead",
    "tap_invite",
    "tap_edit",
    // "Next 10" under a list, a product type button, a tapped product.
    "tap_more",
    "tap_product_type",
    "tap_product",
    "tap_ignored",
    "media",
    "text_not_ready",
    "text_agent",
    "text_busy",
    "text_not_configured",
    "typed_confirm",
    "voice_no_speech",
    "voice_too_long",
    "voice_unsupported",
    "voice_failed",
    // E-311 — photos / PDFs / location pins.
    "media_agent",
    "media_batched",
    "media_too_large",
    "media_unsupported",
    "media_failed",
    "error",
] as const;
export type Handling = (typeof HANDLING)[number];

const TEXT_MAX = 2000;

export function clip(s: string | null | undefined, max = TEXT_MAX): string | null {
    if (s == null) return null;
    const chars = [...s];
    return chars.length <= max ? s : chars.slice(0, max).join("");
}

/** Row id, or null when this provider_message_id was already recorded (a Meta redelivery). */
export async function insertInbound(m: InboundMessage): Promise<string | null> {
    const rows = await db
        .insert(assistantWaMessages)
        .values({
            provider_message_id: m.providerMessageId,
            direction: "in",
            type: m.type.slice(0, 20),
            wa_phone: m.waPhone,
            phone_number_id: m.phoneNumberId,
            text: clip(m.text),
            raw_payload: m.raw as never,
        })
        .onConflictDoNothing({ target: assistantWaMessages.provider_message_id })
        .returning({ id: assistantWaMessages.id });
    return rows[0]?.id ?? null;
}

export async function markHandled(
    rowId: string,
    handling: Handling,
    extra: { userId?: string | null; actionId?: string | null; error?: string | null; text?: string | null } = {},
): Promise<void> {
    await db
        .update(assistantWaMessages)
        .set({
            handling,
            handled_at: new Date(),
            ...(extra.userId !== undefined ? { user_id: extra.userId } : {}),
            ...(extra.actionId !== undefined ? { action_id: extra.actionId } : {}),
            ...(extra.error !== undefined ? { error: clip(extra.error, 1000) } : {}),
            // A voice note's transcript: what the agent was given, for review.
            ...(extra.text !== undefined ? { text: clip(extra.text) } : {}),
        })
        .where(eq(assistantWaMessages.id, rowId));
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** Delivery receipt → our outbound row. Returns false when nothing was updated. */
export async function applyStatus(wamid: string, status: string): Promise<boolean> {
    if (status !== "failed" && !(status in STATUS_RANK)) return false;
    const rank = STATUS_RANK[status] ?? 0;
    const rows = await db
        .update(assistantWaMessages)
        .set({ delivery_status: status })
        .where(
            and(
                eq(assistantWaMessages.provider_message_id, wamid),
                eq(assistantWaMessages.direction, "out"),
                status === "failed"
                    ? sql`true`
                    : sql`COALESCE(CASE ${assistantWaMessages.delivery_status}
                                     WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
                                   END, 0) < ${rank}`,
            ),
        )
        .returning({ id: assistantWaMessages.id });
    return rows.length > 0;
}

export async function recordOutbound(o: {
    waPhone: string;
    userId: string | null;
    type: "text" | "buttons" | "list";
    text: string;
    wamid: string | null;
    error?: string | null;
    actionId?: string | null;
    raw?: unknown;
}): Promise<void> {
    await db.insert(assistantWaMessages).values({
        provider_message_id: o.wamid || null,
        direction: "out",
        type: o.type,
        user_id: o.userId,
        wa_phone: o.waPhone,
        text: clip(o.text),
        delivery_status: o.wamid ? null : "failed",
        error: clip(o.error ?? null, 1000),
        action_id: o.actionId ?? null,
        raw_payload: (o.raw ?? null) as never,
    });
}

/**
 * Album batching (E-311): is ANY message from this sender recorded after this
 * row — another photo of the album, or the text typed right after the photo
 * ("visit done", the lead's name)? That later message answers for this one;
 * it sees every unused attachment. Every message of a webhook batch is
 * recorded before any is routed, so this also sees the rest of the batch.
 * A button / list tap is not counted: it never runs the agent, so the photo
 * would otherwise go unanswered (e.g. a photo, then Confirm on an older card).
 */
export async function hasNewerInbound(waPhone: string, rowId: string): Promise<boolean> {
    const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM assistant_wa_messages m
         WHERE m.direction = 'in' AND m.wa_phone = ${waPhone}
           AND m.type <> 'interactive'
           AND m.id <> ${rowId}::uuid
           AND m.created_at > (SELECT created_at FROM assistant_wa_messages WHERE id = ${rowId}::uuid)
         LIMIT 1
    `);
    return rows.length > 0;
}

/**
 * Is the user's latest outbound message a change card that is still waiting?
 * Only then is a bare "haan" an attempt to confirm it; after anything else
 * (a list, an answer) it is an answer to that, for the agent.
 */
export async function pendingCardIsLatest(userId: string): Promise<boolean> {
    const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one
          FROM (SELECT action_id FROM assistant_wa_messages
                 WHERE direction = 'out' AND user_id = ${userId}::uuid
                 ORDER BY created_at DESC LIMIT 1) last
          JOIN assistant_actions a ON a.id = last.action_id
         WHERE a.user_id = ${userId}::uuid AND a.status = 'pending' AND a.expires_at > now()
    `);
    return rows.length > 0;
}
