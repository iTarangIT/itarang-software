export type NbfcStatus = string | null | undefined;

/**
 * True once the CEO has approved the NBFC. After this point every past
 * wizard step (Master / Documents / Agreement / KYC) renders read-only
 * for both admin and CEO — the underlying data is contractually frozen
 * (the agreement bundle has been sent to Digio). The server-side
 * status-transition guards already block destructive writes; this just
 * keeps the UI from offering controls that would error out.
 */
export function isNbfcLocked(status: NbfcStatus): boolean {
  return status === "approved" || status === "active";
}
