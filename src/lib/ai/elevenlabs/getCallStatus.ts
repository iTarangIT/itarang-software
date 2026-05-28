// ElevenLabs conversation status polling primitive. Used by
// /api/cron/dialer-poll and the dev-side polling tick to recover from
// dropped webhooks: GET the conversation, and if it's in a terminal state,
// hand off to finalizeElevenLabsCall.
//
// The ElevenLabs Conversational AI API documents this as:
//   GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}
// Auth: header `xi-api-key: <ELEVENLABS_API_KEY>`.
//
// Returns a normalized shape so the poller doesn't have to know about
// ElevenLabs' specific response keys.

const BASE_URL = process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";

export type NormalizedElevenLabsStatus = {
  success: boolean;
  // Terminal statuses we want to act on. Anything else (initiated, in-
  // progress, etc.) means keep waiting.
  status: string;
  isTerminal: boolean;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  rawTranscriptTurns?: unknown[];
  error?: string;
};

// ElevenLabs' status field. "done" is the v1 terminal state; older
// responses also use "completed". The convai docs occasionally surface
// "failed" / "ended" — treat any of these as terminal.
const TERMINAL = new Set([
  "done",
  "completed",
  "failed",
  "ended",
  "no_answer",
  "busy",
  "canceled",
]);

function transcriptTurnsToString(turns: unknown): string | null {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const lines: string[] = [];
  for (const t of turns) {
    if (!t || typeof t !== "object") continue;
    const turn = t as { role?: string; message?: string };
    const role = (turn.role || "").toLowerCase();
    const speaker =
      role === "user" ? "user" : role === "agent" ? "agent" : role;
    const message = (turn.message || "").trim();
    if (message && speaker) lines.push(`${speaker}: ${message}`);
  }
  return lines.length ? lines.join("\n") : null;
}

export async function getElevenLabsCallStatus(
  conversationId: string,
): Promise<NormalizedElevenLabsStatus> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      status: "unknown",
      isTerminal: false,
      transcript: null,
      recordingUrl: null,
      duration: null,
      phone: null,
      error: "ELEVENLABS_API_KEY not set",
    };
  }

  try {
    const res = await fetch(
      `${BASE_URL}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      {
        headers: { "xi-api-key": apiKey, accept: "application/json" },
      },
    );

    if (!res.ok) {
      return {
        success: false,
        status: "unknown",
        isTerminal: false,
        transcript: null,
        recordingUrl: null,
        duration: null,
        phone: null,
        error: `ElevenLabs status ${res.status}`,
      };
    }

    const data: any = await res.json();

    // ElevenLabs surface for status can be in either `status` or
    // `call_status`. Default to "unknown" if missing.
    const rawStatus: string =
      (data?.status as string) ||
      (data?.call_status as string) ||
      "unknown";

    const transcript = transcriptTurnsToString(data?.transcript);
    const recordingUrl =
      data?.metadata?.recording_url ||
      data?.recording_url ||
      null;
    const duration =
      typeof data?.metadata?.call_duration_secs === "number"
        ? data.metadata.call_duration_secs
        : typeof data?.call_duration_secs === "number"
          ? data.call_duration_secs
          : null;
    const phone =
      data?.metadata?.phone_call?.external_number ||
      data?.conversation_initiation_client_data?.dynamic_variables
        ?.phone_number ||
      null;

    return {
      success: true,
      status: rawStatus,
      isTerminal: TERMINAL.has(rawStatus.toLowerCase()),
      transcript,
      recordingUrl,
      duration,
      phone,
      rawTranscriptTurns: Array.isArray(data?.transcript)
        ? data.transcript
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      status: "unknown",
      isTerminal: false,
      transcript: null,
      recordingUrl: null,
      duration: null,
      phone: null,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
