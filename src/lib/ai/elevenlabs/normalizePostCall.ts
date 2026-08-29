/**
 * Turning an ElevenLabs post-call webhook into the fields we store.
 *
 * Pure — no database import, no network — so the rules below can be tested
 * without a webhook delivery and a live conversation. Same split as
 * databaseMath.ts and elevenlabsSeries.ts.
 *
 * WHY THIS EXISTS AT ALL. Every one of these fields was previously derived
 * inline in the handler, and three of them were derived wrongly:
 *
 *   - `ended_at` was the moment we happened to write the row, not when the call
 *     ended. Every date-bounded query on /operations/elevenlabs buckets on
 *     ended_at, so a webhook arriving after midnight IST filed its call under
 *     the wrong day, and a retry or backfill under the wrong month.
 *   - `status` was the literal "completed" for every event. In August 2026, 390
 *     of 738 real conversations had failed; all of them would have been
 *     recorded as successes.
 *   - `lead_id` was never read, even though the app puts it on every call it
 *     places. Attribution fell back to matching phone strings, which fails on
 *     format alone — inbound numbers arrive as "08035315136" against stored
 *     "+91..." values.
 *
 * The rule throughout: report what the provider said, and return null rather
 * than a plausible-looking default when it said nothing.
 */

import type {
  ElevenLabsPostCallTranscriptionData,
  ElevenLabsTranscriptTurn,
} from "./types";

/** Flatten the turn array into the "speaker: message" text we store. */
export function transcriptArrayToString(
  turns?: ElevenLabsTranscriptTurn[],
): string {
  if (!Array.isArray(turns) || turns.length === 0) return "";
  return turns
    .map((t) => {
      const role = (t.role || "").toLowerCase();
      const speaker =
        role === "user" ? "user" : role === "agent" ? "agent" : role;
      const message = (t.message || "").trim();
      return message ? `${speaker}: ${message}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export interface NormalizedPostCall {
  conversationId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  leadId: string | undefined;
  agentId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

type Meta = {
  start_time_unix_secs?: number;
  call_duration_secs?: number;
  recording_url?: string | null;
  phone_call?: { external_number?: string };
};

/**
 * Seconds the call lasted, or null when the provider did not say.
 *
 * Null and 0 are different answers and must stay different: 0 is a call that
 * connected to nothing, null is a call whose duration we do not know. Only the
 * first is a fact worth storing.
 */
export function callDuration(meta: unknown): number | null {
  const d = (meta as Meta | undefined)?.call_duration_secs;
  return typeof d === "number" && Number.isFinite(d) ? d : null;
}

/**
 * When the call started, from the provider's clock.
 *
 * `start_time_unix_secs` is SECONDS. The ×1000 is load-bearing — treating it as
 * milliseconds dates every call to January 1970 and silently empties the
 * dashboard's every window.
 */
export function callStartedAt(meta: unknown): Date | null {
  const s = (meta as Meta | undefined)?.start_time_unix_secs;
  return typeof s === "number" && Number.isFinite(s) && s > 0
    ? new Date(s * 1000)
    : null;
}

/**
 * When the call ended: start + duration.
 *
 * DERIVED, because ElevenLabs sends no end timestamp. A zero-duration failed
 * call therefore ends at the instant it started — which is the point. The
 * obvious alternative, leaving ended_at NULL when there is no duration, is what
 * the backfill script used to do, and NULL fails every `ended_at >= …`
 * comparison on the page. Those rows land in the table and are then counted by
 * nothing: not the tiles, not first_call_at, not the month dropdown.
 */
export function callEndedAt(meta: unknown): Date | null {
  const startedAt = callStartedAt(meta);
  if (!startedAt) return null;
  return new Date(startedAt.getTime() + (callDuration(meta) ?? 0) * 1000);
}

/** Normalize a verified post_call_transcription payload into stored fields. */
export function normalizePostCall(
  data: ElevenLabsPostCallTranscriptionData,
): NormalizedPostCall {
  const meta = data.metadata as Meta | undefined;
  const dyn = data.conversation_initiation_client_data?.dynamic_variables;

  const transcript = transcriptArrayToString(data.transcript);

  // Prefer the number the provider dialled; fall back to the one we asked it
  // to dial. Both can be absent on an inbound call.
  const phone =
    meta?.phone_call?.external_number ||
    (dyn?.phone_number as string | undefined) ||
    "";

  // Only a non-empty string is an id. "" would be passed along as a hint and
  // then match no lead, which is indistinguishable from having no hint —
  // except that it costs a query.
  const rawLeadId = dyn?.lead_id;
  const leadId =
    typeof rawLeadId === "string" && rawLeadId.trim() ? rawLeadId : undefined;

  return {
    conversationId: data.conversation_id,
    status: data.status || "completed",
    transcript: transcript || null,
    recordingUrl: meta?.recording_url ?? null,
    duration: callDuration(meta),
    phone: phone || null,
    leadId,
    agentId: data.agent_id ?? null,
    startedAt: callStartedAt(meta),
    endedAt: callEndedAt(meta),
  };
}
