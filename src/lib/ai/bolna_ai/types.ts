export interface BolnaCallPayload {
  leadId: string;
  phone: string;
  name?: string;
  context?: string;
  scheduledAt?: string;
}

export interface BolnaCallResponse {
  success: boolean;
  call_id?: string;
  error?: string;
  // True when the call was suppressed by the idempotency guard (already
  // dispatched for this lead+phone+day). Caller can treat as no-op success.
  deduped?: boolean;
}

export interface BolnaWebhookPayload {
  call_id: string;
  phone: string;
  transcript: string;
}
