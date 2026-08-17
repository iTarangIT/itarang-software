/**
 * E-243 — a dealer answering a quotation from WhatsApp.
 *
 * ## Buttons, not words
 *
 * The quotation goes out with two interactive buttons, so the reply arrives as
 * a button ID we minted — `quote_approve:<commercial_id>` — and not as prose.
 * That matters more here than it looks: the alternative is guessing whether
 * "ok", "haan", "ok but what about the charger" or "ok send" is an approval,
 * and a wrong guess records a dealer approving a price they did not approve.
 * A tap is unambiguous, so this module only ever acts on a tap.
 *
 * Free text from a dealer therefore falls through to the normal orchestrator,
 * exactly as it did before. Nothing about the existing flows changes.
 *
 * ## The sender is authorised against the dispatch log, not the button
 *
 * A button ID travels in a message body, so anyone could post
 * `quote_approve:<uuid>` from any number. The ID alone is not authority. The
 * gate is `quotation_dispatches`: this quotation must actually have been sent
 * over WhatsApp to THIS number. That is the WhatsApp equivalent of the signed
 * token on the link path — the credential is "we sent it to you", and it is
 * checked against a row we wrote, not against anything the sender supplied.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recordDealerDecision } from "@/lib/leads/quoteDecision";
import { parseQuotationButton } from "./quotationButton";
import { getAdapter } from "./index";
import type { InboundEvent } from "./types";

// The button vocabulary and its parser live in ./quotationButton — pure, and
// imported by quoteDispatch when it ATTACHES the buttons, so both sides of the
// round trip read their IDs from one place.
export {
  QUOTE_APPROVE_PREFIX,
  QUOTE_DECLINE_PREFIX,
  parseQuotationButton,
  type QuotationButtonPress,
} from "./quotationButton";

/** Compare two numbers by their last ten digits — country-code forms differ. */
function samePhone(a: string, b: string): boolean {
  const ta = a.replace(/\D/g, "").slice(-10);
  const tb = b.replace(/\D/g, "").slice(-10);
  return ta.length === 10 && ta === tb;
}

/**
 * Did we actually send this quotation to this number over WhatsApp?
 *
 * The authorisation check. Reads only rows we wrote, so a sender cannot talk
 * their way past it. `status = 'sent'` is deliberate: a dispatch that failed
 * never reached the dealer, so it cannot be the thing they are answering.
 */
async function wasSentToThisNumber(
  commercialId: string,
  waPhone: string,
): Promise<boolean> {
  try {
    const rows = await db.execute<{ recipient: string }>(sql`
      SELECT recipient
        FROM quotation_dispatches
       WHERE commercial_id = ${commercialId}::uuid
         AND channel = 'whatsapp'
         AND status  = 'sent'
       ORDER BY created_at DESC
       LIMIT 20
    `);
    return (rows as unknown as { recipient: string }[]).some((r) =>
      samePhone(r.recipient, waPhone),
    );
  } catch (e) {
    // E-242 not applied, or the table is unreachable. FAIL CLOSED: an
    // unverifiable sender is not an authorised one.
    console.error("[whatsapp/quotationReply] dispatch lookup failed", e);
    return false;
  }
}

async function say(to: string, body: string): Promise<void> {
  try {
    await getAdapter().sendText(to, body);
  } catch (e) {
    // The decision is already recorded; failing to acknowledge it must not
    // make the handler look unhandled and drop the dealer into onboarding.
    console.error("[whatsapp/quotationReply] acknowledgement failed", e);
  }
}

/**
 * Handle a quotation button press.
 *
 * Returns TRUE when this module owned the message — the caller must then stop,
 * so a dealer answering a quotation is never also fed into the onboarding or
 * console state machines. Returns false for everything else, leaving the
 * existing orchestrator behaviour exactly as it was.
 */
export async function handleQuotationReply(event: InboundEvent): Promise<boolean> {
  const press = parseQuotationButton(event.text);
  if (!press) return false;

  // From here on the message IS ours: it carries a button ID only we mint, so
  // every path below returns true even when it refuses. Falling through to the
  // onboarding machine with `quote_approve:…` as the answer to "what is your
  // company name?" would be worse than any refusal.
  const authorised = await wasSentToThisNumber(press.commercialId, event.waPhone);
  if (!authorised) {
    console.warn("[whatsapp/quotationReply] unauthorised press", {
      commercialId: press.commercialId,
      // Last four only — the rest is PII in a log line.
      phoneTail: event.waPhone.slice(-4),
    });
    await say(
      event.waPhone,
      "Sorry, we couldn't match that response to a quotation sent to this number. " +
        "Please contact your iTarang representative.",
    );
    return true;
  }

  const result = await recordDealerDecision({
    commercialId: press.commercialId,
    decision: press.decision,
    via: "whatsapp",
    actor: event.waPhone,
    note: null,
  });

  switch (result.outcome) {
    case "recorded":
      await say(
        event.waPhone,
        result.decision === "approved"
          ? `Thank you — your approval of quotation ${result.quoteNumber ?? ""} is recorded. ` +
              `Your iTarang representative will be in touch.`.replace(/\s+/g, " ")
          : `Thank you — we've recorded that quotation ${result.quoteNumber ?? ""} isn't right for you. ` +
              `Your iTarang representative will follow up.`.replace(/\s+/g, " "),
      );
      return true;

    case "already_answered":
      await say(
        event.waPhone,
        `You've already responded to quotation ${result.quoteNumber ?? ""} ` +
          `(${result.decision}). Nothing further is needed.`.replace(/\s+/g, " "),
      );
      return true;

    case "not_sendable":
      await say(event.waPhone, result.reason);
      return true;

    default:
      await say(
        event.waPhone,
        "Sorry, we couldn't find that quotation. Please contact your iTarang representative.",
      );
      return true;
  }
}
