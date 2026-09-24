// The Assistant's deterministic message router (BRD §8.3; plan D1).
//
// The webhook has already verified the signature, dropped foreign
// phone_number_ids, deduped the message into assistant_wa_messages and
// answered 200. This runs in after(), one message at a time, and the FIRST
// matching step ends the turn:
//
//   1. "LINK 123456"   → link handler. Works from unlinked numbers. No model.
//   2. Identity        → no active binding, inactive user, or a role other than
//                        asm / inside_sales_rep → the fixed UC-13 reply. No model,
//                        no data.
//   3. Kill switch     → ASSISTANT_DISABLED → one fixed reply. No model, no data.
//   4. Button / list tap (interactive replyId)
//                        ast:c:<id> → executor, ast:x:<id> → cancel,
//                        ast:lead:<id> → lead details (Gates 3–4); until then
//                        logged and ignored. A tap never reaches the model.
//   5. Non-text        → the fixed UC-14 reply, counted by `type`.
//   6. Text            → a bare "yes / haan / confirm" while a preview is
//                        waiting gets the fixed "tap Confirm" reply (typing never
//                        saves); anything else → per-user lease → agent → reply.
//
// Every message ends with a `handling` value on its row. Any unexpected error
// is logged with the provider message id and answered with one generic
// "nothing was changed" reply.

import type { InboundMessage } from "./parse";
import type { Handling } from "./messages";
import type { LinkOutcome } from "./link";
import type { SenderResolution } from "./identity";
import type { AssistantUser } from "@/lib/assistant/types";
import { parseLinkCommand } from "./link";
import { REPLY, linkedReply, linkLockedReply } from "./replies";

/** What running one text turn produced — the channel only needs the reply. */
export type TextTurnOutcome =
    | { kind: "ok"; text: string; modelCalls: number; toolCalls: number }
    | { kind: "busy" }
    | { kind: "not_configured" };

export type RouterDeps = {
    verifyLink: (args: { waPhone: string; code: string; messageRowId: string }) => Promise<LinkOutcome>;
    resolveSender: (waPhone: string) => Promise<SenderResolution>;
    markHandled: (
        rowId: string,
        handling: Handling,
        extra?: { userId?: string | null; actionId?: string | null; error?: string | null },
    ) => Promise<void>;
    /** Send a plain text reply and log it. Never throws. */
    replyText: (waPhone: string, text: string, userId: string | null) => Promise<void>;
    /** ASSISTANT_DISABLED, read per message. */
    isDisabled: () => boolean;
    hasPendingAction: (userId: string) => Promise<boolean>;
    /** Lease → agent → memory, for one text message. */
    runTextTurn: (user: AssistantUser, text: string, messageRowId: string) => Promise<TextTurnOutcome>;
    log: (level: "info" | "warn" | "error", msg: string, meta: Record<string, unknown>) => void;
};

const TAP_RE = /^ast:(c|x|lead):(.+)$/;

/**
 * A message that is nothing but an attempt to confirm by typing. Only answered
 * deterministically when a preview is actually waiting; otherwise it is an
 * ordinary message for the agent.
 */
const TYPED_CONFIRM_RE =
    /^\s*(yes|yess+|y|yeah|yup|ok|okay|confirm|confirmed|done|haan|haa|han|ha|hanji|haan ji|ji|theek hai|thik hai|thik h|kar do|save|save it|go ahead)\s*[.!👍✅]*\s*$/i;

export function isTypedConfirm(text: string | null | undefined): boolean {
    return TYPED_CONFIRM_RE.test(text ?? "");
}

/** Mask a phone for logs: +9198•••••210. */
export function maskPhone(waPhone: string): string {
    return waPhone.length > 7 ? `${waPhone.slice(0, 5)}•••••${waPhone.slice(-3)}` : "•••";
}

export async function routeMessage(msg: InboundMessage, rowId: string, deps: RouterDeps): Promise<void> {
    const started = Date.now();
    const meta = { waMessageId: msg.providerMessageId, phone: maskPhone(msg.waPhone), type: msg.type };
    let userId: string | null = null;
    try {
        // 1. LINK — before identity, so an unlinked number can link.
        const code = msg.type === "text" ? parseLinkCommand(msg.text) : null;
        if (code) {
            const outcome = await deps.verifyLink({ waPhone: msg.waPhone, code, messageRowId: rowId });
            // verifyLink records the handling itself, inside its lock.
            const text =
                outcome.kind === "linked"
                    ? linkedReply(outcome.user.name, outcome.user.role)
                    : outcome.kind === "locked"
                      ? linkLockedReply(outcome.until)
                      : outcome.kind === "ineligible"
                        ? REPLY.unlinked
                        : REPLY.linkInvalid;
            await deps.replyText(msg.waPhone, text, outcome.kind === "linked" ? outcome.user.id : null);
            deps.log("info", "[wa-assist] link attempt", { ...meta, outcome: outcome.kind, latencyMs: Date.now() - started });
            return;
        }

        // 2. Identity — re-resolved on every message.
        const sender = await deps.resolveSender(msg.waPhone);
        if (sender.kind !== "ok") {
            await deps.markHandled(rowId, "unlinked", {
                userId: sender.kind === "revoked" ? sender.userId : null,
            });
            await deps.replyText(msg.waPhone, REPLY.unlinked, null);
            deps.log("info", "[wa-assist] unlinked sender", {
                ...meta,
                resolution: sender.kind === "revoked" ? `revoked:${sender.reason}` : "unlinked",
            });
            return;
        }
        const user = sender.user;
        userId = user.id;

        // 3. Kill switch.
        if (deps.isDisabled()) {
            await deps.markHandled(rowId, "disabled", { userId });
            await deps.replyText(msg.waPhone, REPLY.disabled, userId);
            return;
        }

        // 4. Taps — never the model.
        if (msg.type === "interactive") {
            const tap = TAP_RE.exec(msg.replyId ?? "");
            await deps.markHandled(rowId, "tap_ignored", { userId });
            deps.log("info", "[wa-assist] tap ignored", { ...meta, userId, tap: tap?.[1] ?? "unknown" });
            return;
        }

        // 5. Anything that is not typed text.
        if (msg.type !== "text") {
            await deps.markHandled(rowId, "media", { userId });
            await deps.replyText(msg.waPhone, REPLY.media, userId);
            deps.log("info", "[wa-assist] media", { ...meta, userId });
            return;
        }

        // 6. Text.
        const text = msg.text ?? "";
        if (isTypedConfirm(text) && (await deps.hasPendingAction(userId))) {
            await deps.markHandled(rowId, "typed_confirm", { userId });
            await deps.replyText(msg.waPhone, REPLY.tapConfirm, userId);
            return;
        }

        const outcome = await deps.runTextTurn(user, text, rowId);
        if (outcome.kind === "busy") {
            await deps.markHandled(rowId, "text_busy", { userId });
            await deps.replyText(msg.waPhone, REPLY.busy, userId);
        } else if (outcome.kind === "not_configured") {
            await deps.markHandled(rowId, "text_not_configured", { userId });
            await deps.replyText(msg.waPhone, REPLY.notReady, userId);
            deps.log("error", "[wa-assist] agent not configured (ASSISTANT_MODEL / OPENAI_API_KEY)", meta);
        } else {
            await deps.markHandled(rowId, "text_agent", { userId });
            await deps.replyText(msg.waPhone, outcome.text, userId);
            deps.log("info", "[wa-assist] turn", {
                ...meta,
                userId,
                modelCalls: outcome.modelCalls,
                toolCalls: outcome.toolCalls,
                latencyMs: Date.now() - started,
            });
        }
    } catch (err) {
        deps.log("error", "[wa-assist] turn failed", {
            ...meta,
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
        try {
            await deps.markHandled(rowId, "error", {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
        } catch {
            // The log line above is the record of last resort.
        }
        await deps.replyText(msg.waPhone, REPLY.genericError, userId);
    }
}
