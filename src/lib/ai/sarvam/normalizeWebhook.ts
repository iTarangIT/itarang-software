/**
 * Turning a Sarvam Instant Outbound call-end webhook into what we store.
 *
 * Pure — no database, no network, no env — so the mapping in the handoff
 * spec's "Field mapping" table can be asserted on without a live call. Same
 * split as elevenlabs/normalizePostCall.ts.
 *
 * The rule throughout, as for ElevenLabs: report what the provider said, and
 * return null rather than a plausible default when it said nothing. Sarvam's
 * payload has no timestamps and no dialled number, so those come from our own
 * receipt time and the metadata we attached when placing the call.
 */

import { transcriptArrayToString } from "@/lib/ai/elevenlabs/normalizePostCall";
import type { ElevenLabsFinalizePayload } from "@/lib/ai/elevenlabs/finalizeCall";
import type { SarvamTranscriptTurn, SarvamWebhookPayload } from "./types";

/** Statuses that mean the call never connected — they never reach finalize. */
export const SARVAM_NOT_CONNECTED = new Set(["no_answer", "busy", "failed"]);

export function isSarvamConnected(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "connected";
}

/**
 * The provider status handed to finalize for a connected call. "done" is one
 * of the values classifyCallEnd treats as a normally finished call (see
 * campaignLeadStatus.ts) — "completed" itself still needs a dealer turn in the
 * transcript, which classifyCallEnd reads separately.
 */
export const SARVAM_CONNECTED_FINALIZE_STATUS = "done";

/** Flatten Sarvam turns into the "agent: …" / "user: …" text we store. */
export function sarvamTranscriptToString(
  turns: SarvamTranscriptTurn[] | null | undefined,
): string {
  if (!Array.isArray(turns)) return "";
  return transcriptArrayToString(
    turns.map((t) => ({
      role: t?.role ?? "",
      message: (t?.en_text ?? t?.indic_text ?? "") || "",
    })),
  );
}

/** One `final_agent_variables` value as a trimmed string, or null. */
export function agentVariable(
  vars: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const v = vars?.[key];
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Sarvam sends callback_agreed as "yes" / "no". Anything else is unknown. */
export function yesNo(value: string | null): boolean | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (["yes", "true", "y", "haan", "1"].includes(v)) return true;
  if (["no", "false", "n", "nahi", "0"].includes(v)) return false;
  return null;
}

/** "yes" / "no" for a recognised answer, the raw text otherwise, null when absent. */
export function canonicalYesNo(value: string | null): string | null {
  const b = yesNo(value);
  if (b === null) return value;
  return b ? "yes" : "no";
}

/** Seconds, or null. Keeps null as null — "not connected" is not "0s". */
export function sarvamDuration(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Evidence for classifyCallEnd on a not-connected attempt.
 *
 * `no_answer` and `busy` are Sarvam's own verdict and authoritative, so they
 * are passed as the failure text themselves. The free-text failure_reason is
 * used only for `failed`: it is "usually prefixed with the carrier name", and
 * words in a carrier name must not decide busy-vs-no-answer.
 */
export function sarvamNotConnectedEvidence(p: Pick<SarvamWebhookPayload, "status" | "failure_reason">): {
  providerStatus: string;
  initiationFailureReason: string;
  outcome: string;
} {
  const status = (p.status ?? "").trim().toLowerCase() || "failed";
  const reason = (p.failure_reason ?? "").trim();
  if (status === "no_answer") {
    return { providerStatus: status, initiationFailureReason: "no answer", outcome: "no_answer" };
  }
  if (status === "busy") {
    return { providerStatus: status, initiationFailureReason: "busy", outcome: "busy" };
  }
  return {
    providerStatus: status,
    initiationFailureReason: reason || status,
    outcome: reason ? `sarvam_failed: ${reason}`.slice(0, 200) : "sarvam_failed",
  };
}

export type NormalizedSarvamCall = ElevenLabsFinalizePayload & {
  provider: "sarvam";
  /** Recording key for the analytics API; null when there is none. */
  interactionId: string | null;
  /** callback_agreed as "yes" / "no" — the same shape ElevenLabs data collection sends. */
  callbackAgreed: string | null;
  /** The agent is Hindi only. */
  callLanguage: "hi";
  /** Sarvam's own scoring — a second opinion; the CRM still scores the transcript itself. */
  providerExtras: {
    intentScore: string | null;
    leadQualified: string | null;
    callbackTime: string | null;
    channelProvider: string | null;
  };
};

/**
 * Map a CONNECTED Sarvam webhook to the shared finalize payload.
 *
 * `receivedAt` is our receipt time: Sarvam sends no timestamps, so the call
 * is filed as ending when we heard about it, and starting `duration` before.
 */
export function normalizeSarvamWebhook(
  payload: SarvamWebhookPayload,
  opts: { receivedAt: Date; appId: string },
): NormalizedSarvamCall {
  const vars = payload.final_agent_variables ?? null;
  const meta = payload.webhook_config?.metadata ?? {};
  const duration = sarvamDuration(payload.duration);
  const endedAt = opts.receivedAt;
  const startedAt =
    duration != null ? new Date(endedAt.getTime() - duration * 1000) : null;
  const transcript = sarvamTranscriptToString(payload.interaction_transcript);
  const leadId = typeof meta.lead_id === "string" && meta.lead_id.trim() ? meta.lead_id.trim() : undefined;
  const phone = typeof meta.phone === "string" && meta.phone.trim() ? meta.phone.trim() : null;
  const interactionId =
    typeof payload.interaction_id === "string" && payload.interaction_id.trim()
      ? payload.interaction_id.trim()
      : null;

  return {
    provider: "sarvam",
    conversationId: payload.attempt_id,
    status: isSarvamConnected(payload.status)
      ? SARVAM_CONNECTED_FINALIZE_STATUS
      : (payload.status ?? "").trim().toLowerCase(),
    transcript: transcript || null,
    conversation: Array.isArray(payload.interaction_transcript)
      ? payload.interaction_transcript
      : undefined,
    recordingUrl: null,
    duration,
    phone,
    leadId,
    agentId: opts.appId,
    startedAt,
    endedAt,
    // Sarvam handles voicemail itself and plays the configured message.
    terminationReason: null,
    answeredBy: agentVariable(vars, "answered_by"),
    callResult: agentVariable(vars, "call_result"),
    interactionId,
    callbackAgreed: canonicalYesNo(agentVariable(vars, "callback_agreed")),
    callLanguage: "hi",
    providerExtras: {
      intentScore: agentVariable(vars, "intent_score"),
      leadQualified: agentVariable(vars, "lead_qualified"),
      callbackTime: agentVariable(vars, "callback_time"),
      channelProvider: payload.channel_info?.channel_provider?.trim() || null,
    },
  };
}
