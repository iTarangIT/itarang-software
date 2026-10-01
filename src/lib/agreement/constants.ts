/**
 * How long a dealer e-sign agreement stays open on Digio before it expires,
 * counted from initiation (signing is sequential, so every signer shares the
 * same window). Passed to Digio as `expire_in_days` by initiate-agreement and
 * used by the expiry-reminder cron to compute each signer's deadline, so the
 * two must never drift apart — import this, don't restate the number.
 *
 * Digio caps `expire_in_days` at 90 (documented constraints: min 1, max 90).
 * Business asked for 6 months (2026-09-26); 90 days is the longest Digio will
 * accept, so that is the value here. Raising it above 90 makes every
 * initiation fail at Digio.
 */
export const DEALER_AGREEMENT_EXPIRE_IN_DAYS = 90;
export const DIGIO_MAX_EXPIRE_IN_DAYS = 90;
