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
}

export interface BolnaWebhookPayload {
  call_id: string;
  phone: string;
  transcript: string;
}
