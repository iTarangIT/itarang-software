/**
 * Digio multi-template create_sign_request integration.
 *
 * Per BRD 6.0.4a (E-007 — NBFC LSP Agreement initiate), this wraps the
 * `POST /v2/client/template/multi_templates/create_sign_request` endpoint.
 * The caller passes the high-level intent (signers, expiry, callback) and
 * we shape the Digio-side payload here so route handlers stay focused on
 * persistence.
 *
 * Test mode: when NBFC_TEST_BYPASS_SECRET is set in env AND the request
 * carries `x-nbfc-test-bypass` (validated upstream by the route), the route
 * passes `stub: true` here so we return a deterministic synthetic response
 * without calling out. This keeps the AC tests hermetic — they don't need
 * Digio credentials.
 */
import { digioClient } from "./client";

export const DIGIO_MULTI_TEMPLATE_CREATE_SIGN_REQUEST_PATH =
  "/v2/client/template/multi_templates/create_sign_request";

export interface MultiTemplateSigner {
  identifier: string; // email
  name: string;
  reason?: string;
  sign_type?: string;
  signature_type?: string;
}

export interface MultiTemplateCreateInput {
  templates: Array<{ template_key: string; template_values?: Record<string, unknown> }>;
  signers: MultiTemplateSigner[]; // ordered: index 0 signs first when sequential=true
  sequential: boolean;
  expire_in_days: number;
  notify_signers: boolean;
  customer_notification_mode: string;
  callback?: string;
  estamp_request?: { tags?: Record<string, number> };
}

export interface MultiTemplateCreateResponse {
  id: string; // digio document id
  agreement_status?: string;
  [k: string]: unknown;
}

function isTestStubMode(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    !!process.env.NBFC_TEST_BYPASS_SECRET &&
    process.env.NBFC_DIGIO_STUB === "1"
  );
}

/**
 * POST to Digio's multi-template create_sign_request endpoint.
 *
 * Returns the Digio response body (which carries the document id used to
 * track signing progress). When the test stub mode is on, returns a
 * deterministic synthetic id so AC tests can run without external creds.
 */
export async function createMultiTemplateSignRequest(
  input: MultiTemplateCreateInput,
): Promise<MultiTemplateCreateResponse> {
  if (isTestStubMode()) {
    const stamp = Date.now().toString(36);
    return {
      id: `DIGIO-STUB-${stamp}`,
      agreement_status: "SENT_TO_EXTERNAL_PARTY",
      stubbed: true,
    };
  }
  const response = await digioClient.post(
    DIGIO_MULTI_TEMPLATE_CREATE_SIGN_REQUEST_PATH,
    input,
  );
  return response.data as MultiTemplateCreateResponse;
}
