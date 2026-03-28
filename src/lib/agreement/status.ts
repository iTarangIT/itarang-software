export function normalizeAgreementStatus(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Digio Agreement Status → Our Agreement Status
 */
export function mapDigioStatusToAgreementStatus(status: string) {
  const s = String(status || "").toLowerCase();

  if (s === "completed" || s === "signed") return "completed";

  if (s === "partially_signed" || s === "partial") {
    return "partially_signed";
  }

  if (s === "viewed") return "sign_pending";

  if (s === "sent") return "sent_to_external_party";

  if (s === "expired") return "expired";

  if (s === "failed" || s === "rejected") return "failed";

  return "sign_pending";
}

/**
 * Digio Signer Status → Our Signer Status
 */
export function mapDigioSignerStatus(status: string) {
  const s = String(status || "").toLowerCase();

  if (s === "signed" || s === "completed") return "signed";

  if (s === "viewed") return "viewed";

  if (s === "sent") return "sent";

  if (s === "expired") return "expired";

  if (s === "failed" || s === "rejected") return "failed";

  return "pending";
}

/**
 * Admin can re-initiate only when agreement failed or expired
 */
export function canReInitiateAgreement(status?: string | null) {
  const s = String(status || "").toLowerCase();
  return s === "failed" || s === "expired";
}

/**
 * IMPORTANT:
 * When agreement is completed → we should fetch signed agreement + audit trail
 */
export function shouldFetchSignedDocuments(status?: string | null) {
  const s = String(status || "").toLowerCase();
  return s === "completed";
}