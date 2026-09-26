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
    "tap_ignored",
    "media",
    "text_not_ready",
    "text_agent",
    "text_busy",
    "text_not_configured",
    "typed_confirm",
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
    extra: { userId?: string | null; actionId?: string | null; error?: string | null } = {},
): Promise<void> {
    await db
        .update(assistantWaMessages)
        .set({
            handling,
            handled_at: new Date(),
            ...(extra.userId !== undefined ? { user_id: extra.userId } : {}),
            ...(extra.actionId !== undefined ? { action_id: extra.actionId } : {}),
            ...(extra.error !== undefined ? { error: clip(extra.error, 1000) } : {}),
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
