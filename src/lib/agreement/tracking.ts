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
      applicationId: item.applicationId,
      providerDocumentId: item.providerDocumentId || null,
      requestId: item.requestId || null,
      signerRole: item.signerRole,
      signerName: item.signerName,
      signerEmail: item.signerEmail || null,
      signerMobile: item.signerMobile || null,
      signingMethod: item.signingMethod || null,
      providerSignerIdentifier: item.providerSignerIdentifier || null,
      providerSigningUrl: item.providerSigningUrl || null,
      signerStatus: item.signerStatus || "pending",
      providerRawResponse: (item.providerRawResponse as any) || {},
      createdAt: new Date(),
      updatedAt: new Date(),
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
    applicationId: params.applicationId,
    providerDocumentId: params.providerDocumentId || null,
    requestId: params.requestId || null,
    eventType: params.eventType,
    signerRole: params.signerRole || null,
    eventStatus: params.eventStatus || null,
    eventPayload: (params.eventPayload as any) || {},
    createdAt: new Date(),
  });
}