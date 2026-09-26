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
//   4. Button / list tap (interactive replyId) — never the model:
//                        ast:c:<id>    → the action executor (the only write path)
//                        ast:x:<id>    → cancel
//                        ast:lead:<id> → that lead's card via get_lead_details
//                        anything else → logged and ignored.
//   5. Voice note      → downloaded and transcribed (no lease, no agent yet),
//                        the rep is shown what was heard, and the transcript
//                        continues into step 6 exactly as if it had been typed.
//                        Nothing heard / too long / failed → a fixed reply.
//                        WA_ASSIST_VOICE_DISABLED → the UC-14 reply instead.
//      Other non-text  → the fixed UC-14 reply, counted by `type`.
//   6. Text            → a bare "yes / haan / confirm" while a preview is
//                        waiting gets the fixed "tap Confirm" reply (typing — or
//                        saying — never saves); anything else → per-user lease →
//                        agent → reply.
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
import { REPLY, heardReply, linkedReply, linkLockedReply } from "./replies";
import type { WaPayload } from "./render";
import type { TranscribeOutcome } from "./voice/transcribe";

/** What running one text turn produced — the channel only needs the reply. */
export type TextTurnOutcome =
    | { kind: "ok"; payload: WaPayload; modelCalls: number; toolCalls: number }
    | { kind: "busy" }
    | { kind: "not_configured" };

export type RouterDeps = {
    verifyLink: (args: { waPhone: string; code: string; messageRowId: string }) => Promise<LinkOutcome>;
    resolveSender: (waPhone: string) => Promise<SenderResolution>;
    markHandled: (
        rowId: string,
        handling: Handling,
        extra?: { userId?: string | null; actionId?: string | null; error?: string | null; text?: string | null },
    ) => Promise<void>;
    /** Send a plain text reply and log it. Never throws. */
    replyText: (waPhone: string, text: string, userId: string | null) => Promise<void>;
    /** Send a rendered reply (text or list) and log it. Never throws. */
    sendPayload: (waPhone: string, payload: WaPayload, userId: string | null) => Promise<void>;
    /** A tapped list row (ast:lead:<id>): the lead card, scope-checked, no model. */
    openLead: (user: AssistantUser, leadId: string, messageRowId: string) => Promise<WaPayload>;
    /** Confirm tap (ast:c:<id>) → the executor. The ONLY way anything is written. */
    confirmAction: (user: AssistantUser, actionId: string, messageRowId: string) => Promise<WaPayload>;
    /**
     * "Send invite" tap (ast:inv:<leadId>, offered after a conversion) → a
     * PREVIEW of the dealer invite. Proposes only; its own Confirm sends.
     */
    proposeInvite: (user: AssistantUser, leadId: string, messageRowId: string) => Promise<WaPayload>;
    /** Edit tap (ast:e:<id>): remember the card; the next message revises it. Writes nothing. */
    editAction: (user: AssistantUser, actionId: string) => Promise<WaPayload>;
    /** Cancel tap (ast:x:<id>). */
    cancelAction: (user: AssistantUser, actionId: string) => Promise<WaPayload>;
    /** ASSISTANT_DISABLED, read per message. */
    isDisabled: () => boolean;
    hasPendingAction: (userId: string) => Promise<boolean>;
    /** WA_ASSIST_VOICE_DISABLED, read per message: voice notes get the UC-14 reply. */
    isVoiceDisabled: () => boolean;
    /** Download a voice note and turn it into text. Never throws. */
    transcribeVoice: (user: AssistantUser, audio: { id: string; mimeType: string | null }) => Promise<TranscribeOutcome>;
    /** Lease → agent → memory, for one text message. */
    runTextTurn: (user: AssistantUser, text: string, messageRowId: string) => Promise<TextTurnOutcome>;
    log: (level: "info" | "warn" | "error", msg: string, meta: Record<string, unknown>) => void;
};

const TAP_RE = /^ast:(c|x|e|lead|inv):(.+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
            if (tap?.[1] === "c" || tap?.[1] === "x") {
                const actionId = UUID_RE.test(tap[2]) ? tap[2] : null;
                const payload =
                    tap[1] === "c"
                        ? await deps.confirmAction(user, tap[2], rowId)
                        : await deps.cancelAction(user, tap[2]);
                await deps.markHandled(rowId, tap[1] === "c" ? "tap_confirm" : "tap_cancel", { userId, actionId });
                await deps.sendPayload(msg.waPhone, payload, userId);
                deps.log("info", "[wa-assist] action tap", { ...meta, userId, actionId, tap: tap[1], latencyMs: Date.now() - started });
                return;
            }
            if (tap?.[1] === "e") {
                const payload = await deps.editAction(user, tap[2]);
                await deps.markHandled(rowId, "tap_edit", { userId, actionId: UUID_RE.test(tap[2]) ? tap[2] : null });
                await deps.sendPayload(msg.waPhone, payload, userId);
                return;
            }
            if (tap?.[1] === "inv") {
                const payload = await deps.proposeInvite(user, tap[2], rowId);
                await deps.markHandled(rowId, "tap_invite", { userId });
                await deps.sendPayload(msg.waPhone, payload, userId);
                return;
            }
            if (tap?.[1] === "lead") {
                const payload = await deps.openLead(user, tap[2], rowId);
                await deps.markHandled(rowId, "tap_lead", { userId });
                await deps.sendPayload(msg.waPhone, payload, userId);
                return;
            }
            await deps.markHandled(rowId, "tap_ignored", { userId });
            deps.log("info", "[wa-assist] tap ignored", { ...meta, userId, tap: tap?.[1] ?? "unknown" });
            return;
        }

        // 5. Voice notes → text; anything else that is not typed text → UC-14.
        let text: string;
        let transcript: string | undefined;
        if (msg.type === "audio" && !deps.isVoiceDisabled()) {
            const sttStarted = Date.now();
            const heard: TranscribeOutcome = msg.audio
                ? await deps.transcribeVoice(user, msg.audio)
                : { kind: "failed", error: "audio message without a media id" };
            if (heard.kind !== "ok") {
                const [handling, reply] =
                    heard.kind === "no_speech"
                        ? (["voice_no_speech", REPLY.voiceNoSpeech] as const)
                        : heard.kind === "too_long"
                          ? (["voice_too_long", REPLY.voiceTooLong] as const)
                          : heard.kind === "unsupported"
                            ? (["voice_unsupported", REPLY.voiceFailed] as const)
                            : (["voice_failed", REPLY.voiceFailed] as const);
                const error =
                    heard.kind === "failed" ? heard.error : heard.kind === "unsupported" ? `unsupported ${heard.mimeType}` : null;
                await deps.markHandled(rowId, handling, { userId, ...(error ? { error } : {}) });
                await deps.replyText(msg.waPhone, reply, userId);
                deps.log(heard.kind === "failed" ? "warn" : "info", "[wa-assist] voice not usable", {
                    ...meta,
                    userId,
                    outcome: heard.kind,
                    error,
                    sttMs: Date.now() - sttStarted,
                });
                return;
            }
            transcript = heard.text;
            text = heard.text;
            // Shown on its own, before the answer: a preview body is never squeezed.
            await deps.replyText(msg.waPhone, heardReply(heard.text), userId);
            deps.log("info", "[wa-assist] voice transcribed", {
                ...meta,
                userId,
                chars: heard.text.length,
                sttMs: Date.now() - sttStarted,
            });
        } else if (msg.type !== "text") {
            await deps.markHandled(rowId, "media", { userId });
            await deps.replyText(msg.waPhone, deps.isVoiceDisabled() ? REPLY.media : REPLY.mediaNotVoice, userId);
            deps.log("info", "[wa-assist] media", { ...meta, userId });
            return;
        } else {
            text = msg.text ?? "";
        }

        // 6. Text — typed, or a voice note's transcript (stored on the row for review).
        const logged = transcript !== undefined ? { userId, text: transcript } : { userId };
        if (isTypedConfirm(text) && (await deps.hasPendingAction(userId))) {
            await deps.markHandled(rowId, "typed_confirm", logged);
            await deps.replyText(msg.waPhone, REPLY.tapConfirm, userId);
            return;
        }

        const outcome = await deps.runTextTurn(user, text, rowId);
        if (outcome.kind === "busy") {
            await deps.markHandled(rowId, "text_busy", logged);
            await deps.replyText(msg.waPhone, REPLY.busy, userId);
        } else if (outcome.kind === "not_configured") {
            await deps.markHandled(rowId, "text_not_configured", logged);
            await deps.replyText(msg.waPhone, REPLY.notReady, userId);
            deps.log("error", "[wa-assist] agent not configured (WA_ASSIST_GEMINI_API_KEY)", meta);
        } else {
            await deps.markHandled(rowId, "text_agent", logged);
            await deps.sendPayload(msg.waPhone, outcome.payload, userId);
            deps.log("info", "[wa-assist] turn", {
                ...meta,
                userId,
                voice: transcript !== undefined,
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
