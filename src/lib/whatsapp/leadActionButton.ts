/**
 * E-264 — the vocabulary of the journey buttons, and how to read one back.
 *
 * PURE — no database, no adapter, no I/O. Split from ./leadActionReply (which
 * needs both) for the same reason ./quotationButton is split from
 * ./quotationReply: the parser is the security-relevant half and it is testable
 * on its own. Both sides of the round trip — the push that ATTACHES the button
 * and the turn that READS it — import their ids from here, so they cannot drift.
 *
 * WHY THE LEAD ID RIDES IN THE BUTTON ID.
 *
 * The obvious design is to park the chat on a wait-state and push into it, the
 * way pushSignedConsentToWhatsApp does. That breaks in production for a reason
 * that does not show up in a demo: a dealer runs many leads through one WhatsApp
 * number, and ctx.lead holds exactly ONE pointer. A co-borrower request arriving
 * for lead A while the dealer is mid-capture on lead B has nowhere to land.
 *
 * Naming the lead in the button id fixes that, and two other things with it: it
 * works cold (a customer whose session was reset, or who never had one, is still
 * reachable), and it survives finalizeLead() clearing ctx.lead — the tap
 * re-hydrates from the database, so that function needs no change.
 */

export const LEAD_ACTIONS = {
  /** Admin/NBFC asked for a document: send it straight into the chat. */
  dr_send: "dr_send:",
  /** Co-borrower: start capture in chat / open the web form / defer. */
  cb_start: "cb_start:",
  cb_web: "cb_web:",
  cb_later: "cb_later:",
  /** Step 4: choose lenders in chat / open the Section-G page. */
  s4_start: "s4_start:",
  s4_web: "s4_web:",
  /** Offers: open the comparison page / pick a lender (`of_pick:<lead>:<nbfc>`). */
  of_view: "of_view:",
  of_pick: "of_pick:",
  /** Sanction acknowledged; move on to arranging delivery. */
  sn_ack: "sn_ack:",
  /** Dispatch: begin in chat / open the Step-5 cart. */
  dp_start: "dp_start:",
  dp_web: "dp_web:",
  /** Step-4 extra documents: open the ≤10 bucket for this lead in chat. */
  xd_start: "xd_start:",
} as const;

export type LeadActionKey = keyof typeof LEAD_ACTIONS;

export interface LeadActionPress {
  action: LeadActionKey;
  leadId: string;
  /** Second segment, where the action carries one (of_pick → nbfc id). */
  arg?: string;
}

/**
 * `leads.id` is a generated string like `LEAD-20260824-0042` — it is varchar(255),
 * NOT a uuid, so this is a charset+length guard rather than a UUID regex. Its
 * purpose is the same as the one in ./quotationButton: a malformed tail must
 * never reach the database from inside the inbound webhook.
 */
const LEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{4,63}$/;
const NBFC_ID_RE = /^\d{1,10}$/;

/** Actions whose id carries a second segment after the lead id. */
const TWO_ARG_ACTIONS: ReadonlySet<LeadActionKey> = new Set(["of_pick"]);

/**
 * Read a journey button press out of an inbound message.
 *
 * Returns null for anything that is not one of our button ids — including free
 * text that happens to say "add co-borrower". Same reasoning as the quotation
 * parser: acting on prose means guessing, and a wrong guess here routes a
 * customer's loan to a lender they did not choose.
 */
export function parseLeadAction(
  text: string | null | undefined,
): LeadActionPress | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  for (const [action, prefix] of Object.entries(LEAD_ACTIONS) as Array<
    [LeadActionKey, string]
  >) {
    if (!raw.startsWith(prefix)) continue;

    const tail = raw.slice(prefix.length).trim();
    if (!tail) return null;

    if (TWO_ARG_ACTIONS.has(action)) {
      const sep = tail.lastIndexOf(":");
      if (sep <= 0) return null;
      const leadId = tail.slice(0, sep);
      const arg = tail.slice(sep + 1);
      if (!LEAD_ID_RE.test(leadId) || !NBFC_ID_RE.test(arg)) return null;
      return { action, leadId, arg };
    }

    if (!LEAD_ID_RE.test(tail)) return null;
    return { action, leadId: tail };
  }

  return null;
}

/**
 * Build a button id. Callers go through this rather than string-concatenating so
 * that a change to the separator or the prefix cannot break only one side.
 *
 * Meta caps a reply-button id at 256 characters and a list-row id at 200; the
 * longest id this can produce (`of_pick:` + 63 + `:` + 10) is 82.
 */
export function leadActionId(
  action: LeadActionKey,
  leadId: string,
  arg?: string | number,
): string {
  const base = `${LEAD_ACTIONS[action]}${leadId}`;
  return arg === undefined ? base : `${base}:${arg}`;
}
