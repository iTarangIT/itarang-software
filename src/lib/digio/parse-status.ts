export function normalizeAgreementStatus(rawStatus?: string | null) {
  const status = String(rawStatus || "").trim().toLowerCase();

  if (["completed", "signed"].includes(status)) return "completed";
  if (["partially_signed", "partial"].includes(status)) return "partially_signed";
  if (["expired"].includes(status)) return "expired";
  if (["failed", "cancelled", "rejected"].includes(status)) return "failed";

  return "sent_for_signature";
}

export function extractSignedAgreementUrl(parsed: any): string | null {
  return (
    parsed?.signed_agreement_url ||
    parsed?.executed_file_url ||
    parsed?.file_url ||
    parsed?.download_url ||
    parsed?.document_url ||
    parsed?.agreement?.signed_agreement_url ||
    parsed?.agreement?.executed_file_url ||
    parsed?.agreement?.file_url ||
    parsed?.agreement?.download_url ||
    parsed?.agreement?.document_url ||
    parsed?.data?.signed_agreement_url ||
    parsed?.data?.executed_file_url ||
    parsed?.data?.file_url ||
    parsed?.data?.download_url ||
    parsed?.data?.document_url ||
    parsed?.raw?.signed_agreement_url ||
    parsed?.raw?.executed_file_url ||
    parsed?.raw?.file_url ||
    parsed?.raw?.download_url ||
    parsed?.raw?.document_url ||
    null
  );
}

export function extractDigioDocumentId(parsed: any): string | null {
  return (
    parsed?.document_id ||
    parsed?.id ||
    parsed?.agreement?.document_id ||
    parsed?.agreement?.id ||
    parsed?.data?.document_id ||
    parsed?.data?.id ||
    null
  );
}

export function extractSignedAt(parsed: any): string | null {
  return (
    parsed?.signed_at ||
    parsed?.completed_at ||
    parsed?.execution_date ||
    null
  );
}

export function extractAttachedEstampDetails(
  parsed: any,
): Record<string, string[]> | null {
  return (
    parsed?.attached_estamp_details ||
    parsed?.attachedEstampDetails ||
    parsed?.agreement?.attached_estamp_details ||
    parsed?.data?.attached_estamp_details ||
    parsed?.raw?.attached_estamp_details ||
    null
  );
}

export function extractStampCertificateIds(parsed: any): string[] {
  const details = extractAttachedEstampDetails(parsed);
  if (!details || typeof details !== "object") return [];
  return Object.values(details)
    .flat()
    .filter((value): value is string => typeof value === "string" && !!value);
}
