// Bolna call status polling primitive. Thin wrapper around the existing
// getCallStatus in bolna-client.ts that normalizes Bolna's response shape
// into the same surface getElevenLabsCallStatus exposes, so the poller can
// treat both providers uniformly.

import { getCallStatus as bolnaGetCallStatus } from "@/lib/ai/bolna-client";

export type NormalizedBolnaStatus = {
  success: boolean;
  status: string;
  isTerminal: boolean;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  error?: string;
};

// Bolna terminal statuses observed in webhook payloads. "completed" is the
// happy path; the others are no-conversation-but-call-ended states.
const TERMINAL = new Set([
  "completed",
  "failed",
  "busy",
  "no_answer",
  "no-answer",
  "canceled",
  "rejected",
  "call-disconnected",
]);

export async function getBolnaCallStatus(
  callId: string,
): Promise<NormalizedBolnaStatus> {
  if (!callId) {
    return {
      success: false,
      status: "unknown",
      isTerminal: false,
      transcript: null,
      recordingUrl: null,
      duration: null,
      phone: null,
      error: "missing callId",
    };
  }

  const r: any = await bolnaGetCallStatus(callId);

  if (!r?.success) {
    return {
      success: false,
      status: "unknown",
      isTerminal: false,
      transcript: null,
      recordingUrl: null,
      duration: null,
      phone: null,
      error: r?.error || "Bolna status fetch failed",
    };
  }

  const rawStatus: string = r?.status || r?.call_status || "unknown";
  const transcript: string | null = r?.transcript || null;
  const recordingUrl: string | null =
    r?.recording_url || r?.recording || r?.audio_url || null;
  const duration: number | null =
    typeof r?.duration === "number"
      ? r.duration
      : typeof r?.call_duration === "number"
        ? r.call_duration
        : typeof r?.conversation_duration === "number"
          ? r.conversation_duration
          : null;
  const phone: string | null =
    r?.user_number ||
    r?.recipient_phone_number ||
    r?.phone_number ||
    null;

  return {
    success: true,
    status: rawStatus,
    isTerminal: TERMINAL.has(rawStatus.toLowerCase()),
    transcript,
    recordingUrl,
    duration,
    phone,
  };
}
