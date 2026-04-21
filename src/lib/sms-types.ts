// Shared SMS result/param shape used by Decentro and Gupshup helpers and the
// sendKycSms() provider picker. Keeping it in its own file avoids a cycle
// between gupshup.ts and decentro.ts.

export interface SendSmsParams {
  mobile_number: string;
  message: string;
  reference_id?: string;
  // Ordered variables for an approved WhatsApp/SMS template, e.g. ["https://...", "24"].
  // Gupshup uses these when GUPSHUP_TEMPLATE_ID is set; Decentro ignores them.
  templateParams?: string[];
}

export interface SendSmsResult {
  success: boolean;
  skipped?: boolean;
  messageId: string | null;
  error: string | null;
  raw: unknown;
}
