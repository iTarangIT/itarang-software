export interface ElevenLabsCallPayload {
  leadId: string;
  phone: string;
  scheduledAt?: string;
}

export interface ElevenLabsCallResponse {
  success: boolean;
  call_id?: string;
  error?: string;
  // True when the call was suppressed by the idempotency guard (already
  // dispatched for this lead+phone+day). Caller can treat as no-op success.
  deduped?: boolean;
}

export interface ElevenLabsTranscriptTurn {
  role: "user" | "agent" | string;
  message?: string;
  time_in_call_secs?: number;
}

export interface ElevenLabsPostCallTranscriptionData {
  agent_id?: string;
  conversation_id: string;
  status?: string;
  transcript?: ElevenLabsTranscriptTurn[];
  metadata?: {
    phone_call?: {
      external_number?: string;
      direction?: string;
    };
    [k: string]: unknown;
  };
  analysis?: Record<string, unknown>;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
    [k: string]: unknown;
  };
}

export interface ElevenLabsCallInitiationFailureData {
  agent_id?: string;
  conversation_id?: string;
  failure_reason?: string;
  metadata?: Record<string, unknown>;
}

export type ElevenLabsWebhookEvent =
  | { type: "post_call_transcription"; data: ElevenLabsPostCallTranscriptionData }
  | { type: "post_call_audio"; data: { agent_id?: string; conversation_id: string; full_audio?: string } }
  | { type: "call_initiation_failure"; data: ElevenLabsCallInitiationFailureData };
