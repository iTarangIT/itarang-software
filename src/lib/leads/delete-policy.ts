/**
 * E-285 — the purge policy for a customer application, on its own with no I/O.
 *
 * Deleting an application is per-party: the dealer, the iTarang admin and each
 * NBFC the lead was routed to each remove it from their OWN dashboard. This
 * predicate decides the one irreversible step — when the underlying row and its
 * ~20 child tables are actually destroyed.
 *
 * Kept separate from multi-party-delete.ts (which imports the DB client) so the
 * rule can be tested directly.
 */

/** What each party has done with this application, as read from the DB. */
export interface LeadDeleteState {
  dealerDeletedAt: Date | string | null;
  /**
   * Whether the application ever reached an admin queue — a
   * submit-for-verification row or a submitted product selection. False for a
   * lead the dealer created and discarded without sending anywhere.
   */
  adminHolds: boolean;
  adminDeletedAt: Date | string | null;
  /** NBFC assignments for this lead that have NOT been deleted by their tenant. */
  liveNbfcAssignments: number;
}

/**
 * True when every party that actually holds this application has deleted it.
 *
 * `adminHolds` is the qualifier that keeps the old behaviour for junk leads: a
 * dealer discarding a lead nobody else has ever seen still gets an immediate,
 * complete delete. A party with nothing to delete is not made to delete it.
 */
export function isFullyDeleted(state: LeadDeleteState): boolean {
  if (!state.dealerDeletedAt) return false;
  if (state.adminHolds && !state.adminDeletedAt) return false;
  if (state.liveNbfcAssignments > 0) return false;
  return true;
}
