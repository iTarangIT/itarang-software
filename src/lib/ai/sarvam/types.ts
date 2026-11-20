// Sarvam Instant Outbound API shapes.
// Sources: docs.sarvam.ai/voice-agents/api/instant-outbound/create.md and
// .../instant-outbound/webhook-payload.md (read 20 Nov 2026).

export interface SarvamCallPayload {
  leadId: string;
  phone: string;
  scheduledAt?: string;
  /** Skip the once-per-(lead,phone,day) guard — deliberate re-calls only. */
  bypassIdempotency?: boolean;
  /** Ring this number instead of the lead's own (a learned owner mobile, E-379). The lead is then found by leadId. */
  dialPhone?: string;
}

export interface SarvamCallResponse {
  success: boolean;
  /** Sarvam `attempt_id` — the call id stored in dialer_campaign_leads.bolna_call_id. */
  call_id?: string;
  error?: string;
  deduped?: boolean;
}

/** The agent's per-call input variables (Priya: shop_name, owner_name, location). */
export type SarvamAgentVariables = {
  shop_name: string;
  owner_name: string;
  location: string;
};

export interface SarvamCreateOutboundRequest {
  app_config: {
    app_id: string;
    app_version: number;
    connection_config: {
      connection_id: string;
      agent_phone_number: string;
    };
    agent_variables: SarvamAgentVariables;
  };
  user_config: { user_phone_number: string };
  webhook_config: {
    url: string;
    metadata: SarvamWebhookMetadata;
  };
}

export type SarvamWebhookMetadata = {
  lead_id: string;
  phone: string;
};

export interface SarvamCreateOutboundResponse {
  attempt_id?: string;
  /** 422 body. */
  detail?: Array<{ loc?: unknown[]; msg?: string; type?: string }> | string;
}

export type SarvamCallStatus = "connected" | "no_answer" | "busy" | "failed";

export interface SarvamTranscriptTurn {
  role: "agent" | "user" | string;
  en_text?: string | null;
  /** Not documented for instant outbound; read if Sarvam ever sends it. */
  indic_text?: string | null;
}

export interface SarvamWebhookPayload {
  attempt_id: string;
  status: SarvamCallStatus | string;
  /** Seconds; null when not connected. */
  duration?: number | null;
  /** `YYYYMMDD/<id>` — key for the recording. */
  interaction_id?: string | null;
  failure_reason?: string | null;
  final_agent_variables?: Record<string, unknown> | null;
  interaction_transcript?: SarvamTranscriptTurn[] | null;
  webhook_config?: {
    url?: string;
    metadata?: Partial<SarvamWebhookMetadata> & Record<string, unknown>;
  } | null;
  channel_info?: {
    channel_provider?: string;
    agent_phone_number?: string;
  } | null;
}
