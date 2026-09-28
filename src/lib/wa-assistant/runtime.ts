// Production wiring for the router: real DB, real Graph client, the real
// agent, the log. Kept apart from router.ts so the router's decisions are
// tested with fakes.

import { log } from "@/lib/log";
import { assistantConfig } from "@/lib/assistant/config";
import { hasOpenPendingAction, setActionMessageId } from "@/lib/assistant/actions";
import { cancelAction, executeAction } from "@/lib/assistant/executor";
import { beginEdit } from "@/lib/assistant/edit";
import { agentTurn, runToolDirect } from "@/lib/assistant/turn";
import type { WaAssistEnv } from "./env";
import { WaAssistClient } from "./client";
import { resolveSender } from "./identity";
import { verifyLinkCode } from "./link";
import { withUserLease } from "./lock";
import { hasNewerAttachment, markHandled, recordOutbound } from "./messages";
import { isAcceptedMime, MAX_MEDIA_BYTES, normalizeMediaMime, storeLocation, storeMediaFile } from "@/lib/assistant/media";
import { renderLeadCard, renderPreview, renderTapOutcome, renderTurn, type WaPayload } from "./render";
import type { RouterDeps } from "./router";
import type { AssistantUser } from "@/lib/assistant/types";
import {
    hedgeTranscription,
    MAX_VOICE_BYTES,
    transcribeVoice,
    transcribeWithOpenRouter,
    type Transcriber,
} from "./voice/transcribe";
import { loadVoiceVocab } from "./voice/vocab";
import { voiceConfig } from "./voice/config";

const LEAD_NOT_FOUND = "I couldn't find that lead.";

/** An Edit tap: the card stays as it is until the rep says what to change. */
export async function editActionPayload(user: AssistantUser, actionId: string): Promise<WaPayload> {
    const o = await beginEdit(actionId, user);
    if (o.kind === "editing") {
        return {
            kind: "text",
            body: `✏️ Kya badalna hai? Bas change likhiye — jaise "follow-up parso 4 baje" ya "temperature hot". (${o.title})`,
        };
    }
    return renderTapOutcome(o);
}

/** A "Send invite" tap: run invite_dealer_onboarding directly (no model) → its preview, or why not. */
export async function proposeInvitePayload(user: AssistantUser, leadId: string, messageRowId: string): Promise<WaPayload> {
    const r = await runToolDirect(user, "invite_dealer_onboarding", { lead_id: leadId }, { messageId: messageRowId });
    if (r.kind === "preview") return renderPreview(r.preview, r.action_id, { edit: false });
    if (r.kind === "declined") return { kind: "text", body: r.reason };
    return { kind: "text", body: LEAD_NOT_FOUND };
}

export function defaultRouterDeps(env: WaAssistEnv): RouterDeps {
    const client = new WaAssistClient(env);
    const logFn: RouterDeps["log"] = (level, msg, meta) => log[level](msg, meta);

    const sendPayload: RouterDeps["sendPayload"] = async (waPhone, payload, userId) => {
        try {
            const res =
                payload.kind === "list"
                    ? await client.sendList(waPhone, {
                          body: payload.body,
                          button: payload.button,
                          header: payload.header,
                          rows: payload.rows,
                      })
                    : payload.kind === "buttons"
                      ? await client.sendButtons(waPhone, payload.body, payload.buttons)
                      : await client.sendText(waPhone, payload.body);
            const actionId = payload.kind === "buttons" ? (payload.actionId ?? null) : null;
            await recordOutbound({
                waPhone,
                userId,
                type: payload.kind,
                text: payload.body,
                wamid: res.ok ? res.wamid : null,
                error: res.ok ? null : res.error,
                actionId,
                raw:
                    payload.kind === "list"
                        ? { rows: payload.rows.map((r) => r.id) }
                        : payload.kind === "buttons"
                          ? { buttons: payload.buttons.map((b) => b.id) }
                          : null,
            });
            if (actionId && res.ok) await setActionMessageId(actionId, res.wamid);
            if (!res.ok) logFn("error", "[wa-assist] send failed", { status: res.status, error: res.error });
        } catch (err) {
            logFn("error", "[wa-assist] reply failed", {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    return {
        verifyLink: ({ waPhone, code, messageRowId }) =>
            verifyLinkCode({ waPhone, code, messageRowId, secret: env.WA_ASSIST_APP_SECRET }),
        resolveSender,
        markHandled,
        replyText: (waPhone, text, userId) => sendPayload(waPhone, { kind: "text", body: text }, userId),
        sendPayload,
        openLead: async (user, leadId, messageRowId): Promise<WaPayload> => {
            const result = await runToolDirect(user, "get_lead_details", { lead_id: leadId }, { messageId: messageRowId });
            return {
                kind: "text",
                body: result.kind === "lead" ? renderLeadCard(result.lead) : LEAD_NOT_FOUND,
            };
        },
        proposeInvite: proposeInvitePayload,
        editAction: editActionPayload,
        confirmAction: async (user, actionId, messageRowId) =>
            renderTapOutcome(await executeAction(actionId, user, { messageId: messageRowId })),
        cancelAction: async (user, actionId) => renderTapOutcome(await cancelAction(actionId, user)),
        isDisabled: () => assistantConfig().disabled,
        isVoiceDisabled: () => voiceConfig().disabled,
        transcribeVoice: async (user, audio) => {
            // The spelling hints load while the audio downloads.
            const [media, vocab] = await Promise.all([
                client.downloadMedia(audio.id, MAX_VOICE_BYTES),
                loadVoiceVocab(user),
            ]);
            if (!media.ok) {
                return media.tooLarge ? { kind: "too_long" } : { kind: "failed", error: `download: ${media.error}` };
            }
            const cfg = voiceConfig();
            const mimeType = audio.mimeType ?? media.mimeType;
            const direct: Transcriber = (signal) =>
                transcribeVoice({
                    bytes: media.bytes,
                    mimeType,
                    apiKey: assistantConfig().apiKey,
                    model: cfg.model,
                    vocab,
                    signal,
                });
            // Paid OpenRouter first; the free key races it only when it is slow or fails.
            const paid = cfg.openRouter;
            const { outcome, via } = paid
                ? await hedgeTranscription(
                      (signal) => transcribeWithOpenRouter({ bytes: media.bytes, mimeType, ...paid, vocab, signal }),
                      direct,
                  )
                : await hedgeTranscription(direct, null);
            if (paid && via === "backup") {
                logFn("warn", "[wa-assist] voice transcribed by the free-key backup", { userId: user.id, outcome: outcome.kind });
            }
            return outcome;
        },
        // E-311 — photos / PDFs / location pins. WA_ASSIST_MEDIA_DISABLED=true → the UC-14 reply.
        isMediaDisabled: () => (process.env.WA_ASSIST_MEDIA_DISABLED ?? "").trim().toLowerCase() === "true",
        storeMedia: async (user, msg, messageRowId) => {
            try {
                if (msg.type === "location") {
                    if (!msg.location) return { kind: "failed", error: "location message without coordinates" };
                    const row = await storeLocation({
                        userId: user.id,
                        sourceMessageId: messageRowId,
                        latitude: msg.location.lat,
                        longitude: msg.location.lng,
                        name: msg.location.name,
                        address: msg.location.address,
                    });
                    return { kind: "stored", ref: row.ref };
                }
                const m = msg.media;
                if (!m) return { kind: "failed", error: `${msg.type} message without a media id` };
                // A Word / Excel file is refused before downloading it.
                if (m.mimeType && !isAcceptedMime(m.mimeType)) return { kind: "unsupported", mimeType: m.mimeType };
                const media = await client.downloadMedia(m.id, MAX_MEDIA_BYTES);
                if (!media.ok) return media.tooLarge ? { kind: "too_large" } : { kind: "failed", error: `download: ${media.error}` };
                const mime = normalizeMediaMime(m.mimeType ?? media.mimeType);
                if (!mime || !isAcceptedMime(mime)) return { kind: "unsupported", mimeType: mime };
                const row = await storeMediaFile({
                    userId: user.id,
                    sourceMessageId: messageRowId,
                    kind: m.kind,
                    bytes: media.bytes,
                    mimeType: mime,
                    fileName: m.fileName,
                    caption: m.caption,
                });
                return { kind: "stored", ref: row.ref };
            } catch (err) {
                return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
            }
        },
        hasNewerMedia: hasNewerAttachment,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        hasPendingAction: hasOpenPendingAction,
        runTextTurn: async (user, text, messageRowId) => {
            const leased = await withUserLease(user.id, () => agentTurn(user, text, { messageId: messageRowId }));
            if (!leased.ok) return { kind: "busy" };
            const r = leased.value;
            if (r.kind === "ok") {
                if (r.usedBackup) logFn("warn", "[wa-assist] agent turn used the OpenRouter backup", { userId: user.id });
                return {
                    kind: "ok",
                    payload: renderTurn(r),
                    modelCalls: r.modelCalls,
                    toolCalls: r.results.length,
                };
            }
            // no_tools cannot follow a resolved asm/ISR identity; treat as misconfiguration.
            return { kind: "not_configured" };
        },
        log: logFn,
    };
}
