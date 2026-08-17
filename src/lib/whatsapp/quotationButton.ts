/**
 * E-243 — the vocabulary of the two quotation buttons, and how to read one back.
 *
 * PURE — no database, no adapter, no I/O. Split from ./quotationReply (which
 * needs both) for the same reason quote-pdf/config is split from config-store:
 * the parser is the security-relevant half and it is testable on its own.
 *
 * It is also what quoteDispatch imports when it ATTACHES the buttons, so the
 * two sides of the round trip read their IDs from one place and cannot drift.
 */
import type { DealerDecision } from "@/lib/leads/quoteDecision.types";

export const QUOTE_APPROVE_PREFIX = "quote_approve:";
export const QUOTE_DECLINE_PREFIX = "quote_decline:";

export interface QuotationButtonPress {
  commercialId: string;
  decision: DealerDecision;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a quotation button press out of an inbound message.
 *
 * Returns null for anything that is not one of our two button IDs — including
 * free text that happens to contain the words approve or decline. That is the
 * design, not a limitation: acting on prose means guessing whether "ok" or
 * "ok but what about the charger" is an approval, and a wrong guess records a
 * dealer approving a price they never approved.
 */
export function parseQuotationButton(
  text: string | null | undefined,
): QuotationButtonPress | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const [prefix, decision] = raw.startsWith(QUOTE_APPROVE_PREFIX)
    ? [QUOTE_APPROVE_PREFIX, "approved" as const]
    : raw.startsWith(QUOTE_DECLINE_PREFIX)
      ? [QUOTE_DECLINE_PREFIX, "declined" as const]
      : [null, null];

  if (!prefix) return null;

  const commercialId = raw.slice(prefix.length).trim();
  // Must look like the uuid we minted it from. A malformed tail would otherwise
  // reach the database as a ::uuid cast and raise invalid_text_representation
  // inside the inbound webhook.
  if (!UUID_RE.test(commercialId)) return null;

  return { commercialId, decision };
}
