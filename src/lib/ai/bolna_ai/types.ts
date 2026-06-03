export interface BolnaCallPayload {
  leadId: string;
  phone: string;
  name?: string;
  context?: string;
  scheduledAt?: string;
  // Skip the once-per-(lead,phone,day) idempotency guard. Set only for
  // deliberate human-initiated re-calls (e.g. the "Retry failed leads"
  // campaign) where a same-day second dial is the intended behaviour. The
  // guard otherwise stops QStash retries from double-billing one daily attempt.
  bypassIdempotency?: boolean;
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
