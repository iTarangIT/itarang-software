/**
 * Client-safe NeoDove assignment policy (tracker ID 63).
 *
 * Lives in its own module with NO server imports so the push modals can read
 * the same flag the push routes use, instead of each keeping a local copy
 * that had to be "flipped together" by hand.
 *
 * OFF since 29 Sep 2026 (handover P0-9). Pushing or dialling a lead no longer
 * gives it a CRM owner: the owner collected owner-clock breaches on leads
 * NeoDove was still dialling, and assignment counts were inflated. The owner
 * is now set by the first HUMAN call of a linked NeoDove agent (ID 83). The
 * push/dial routes still validate the picker (resolveNeodoveAssignee) so a bad
 * user id is a 400, but skip assignAfterPush while this is false.
 */
export const ASSIGN_ON_PUSH: boolean = false;
