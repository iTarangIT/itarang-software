export interface BolnaCallPayload {
  phone: string;
  name?: string;
  context?: string;
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
