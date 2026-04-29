import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
} from "@/lib/db/schema";

type SignerInput = {
  applicationId: string;
  providerDocumentId?: string | null;
  requestId?: string | null;
  signerRole: string;
  signerName: string;
  signerEmail?: string | null;
  signerMobile?: string | null;
  signingMethod?: string | null;
  providerSignerIdentifier?: string | null;
  providerSigningUrl?: string | null;
  signerStatus?: string | null;
  providerRawResponse?: unknown;
};

export async function insertAgreementSigners(signers: SignerInput[]) {
  if (!signers.length) return;

  await db.insert(dealerAgreementSigners).values(
    signers.map((item) => ({
      application_id: item.applicationId,
      provider_document_id: item.providerDocumentId || null,
      request_id: item.requestId || null,
      signer_role: item.signerRole,
      signer_name: item.signerName,
      signer_email: item.signerEmail || null,
      signer_mobile: item.signerMobile || null,
      signing_method: item.signingMethod || null,
      provider_signer_identifier: item.providerSignerIdentifier || null,
      provider_signing_url: item.providerSigningUrl || null,
      signer_status: item.signerStatus || "pending",
      provider_raw_response: (item.providerRawResponse as any) || {},
      created_at: new Date(),
      updated_at: new Date(),
    }))
  );
}

export async function insertAgreementEvent(params: {
  applicationId: string;
  providerDocumentId?: string | null;
  requestId?: string | null;
  eventType: string;
  signerRole?: string | null;
  eventStatus?: string | null;
  eventPayload?: unknown;
}) {
  await db.insert(dealerAgreementEvents).values({
    application_id: params.applicationId,
    provider_document_id: params.providerDocumentId || null,
    request_id: params.requestId || null,
    event_type: params.eventType,
    signer_role: params.signerRole || null,
    event_status: params.eventStatus || null,
    event_payload: (params.eventPayload as any) || {},
    created_at: new Date(),
  });
}