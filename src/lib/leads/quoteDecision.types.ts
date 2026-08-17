/**
 * E-243 — the dealer-decision vocabulary, with no dependencies.
 *
 * Separated from ./quoteDecision (which needs the database, the notification
 * hub and the touchpoint writer) so the pure consumers — the WhatsApp button
 * parser, zod schemas in routes — can name these values without dragging a
 * database connection into a unit test. Same split as quote-pdf/config vs
 * config-store.
 */

export const DEALER_DECISIONS = ["approved", "declined"] as const;
export type DealerDecision = (typeof DEALER_DECISIONS)[number];

export const DEALER_DECISION_CHANNELS = ["link", "whatsapp"] as const;
export type DealerDecisionChannel = (typeof DEALER_DECISION_CHANNELS)[number];
