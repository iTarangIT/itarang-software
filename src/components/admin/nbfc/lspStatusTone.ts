// Shared LSP agreement status → status-pill colour mapping. The full Digio
// status alphabet (DRAFT, PENDING_CEO_VERIFICATION, SENT_FOR_SIGNATURE,
// SIGN_PENDING, PARTIALLY_SIGNED, SIGNED, COMPLETED, INITIATED, IN_PROGRESS,
// SENT_TO_EXTERNAL_PARTY, FAILED, EXPIRED) lives in two places — the trigger
// path (lsp-agreement-trigger.ts) and the webhook (digio/route.ts) — so we
// keep one tone table any UI surface can reuse.

export const LSP_STATUS_TONE: Record<string, string> = {
  DRAFT: "status-pill-neutral",
  PENDING_CEO_VERIFICATION: "status-pill-neutral",
  INITIATED: "status-pill-info",
  SENT_TO_EXTERNAL_PARTY: "status-pill-info",
  SENT_FOR_SIGNATURE: "status-pill-info",
  SIGN_PENDING: "status-pill-info",
  PARTIALLY_SIGNED: "status-pill-info",
  IN_PROGRESS: "status-pill-info",
  SIGNED: "status-pill-success",
  COMPLETED: "status-pill-success",
  FAILED: "status-pill-danger",
  EXPIRED: "status-pill-danger",
};

// Status set the CEO/Admin surfaces watch as "signing in flight" — used by
// both the directory column and the CEO dashboard card to scope queries.
export const LSP_IN_FLIGHT_STATUSES = [
  "PENDING_CEO_VERIFICATION",
  "SENT_FOR_SIGNATURE",
  "SIGN_PENDING",
  "PARTIALLY_SIGNED",
  "IN_PROGRESS",
  "SENT_TO_EXTERNAL_PARTY",
  "INITIATED",
] as const;

export function lspStatusToneClass(status: string | null | undefined): string {
  if (!status) return "status-pill-neutral";
  return LSP_STATUS_TONE[status] ?? "status-pill-neutral";
}
