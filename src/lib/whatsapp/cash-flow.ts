/**
 * The CASH lead, over WhatsApp: name → vehicle registration → battery → sold.
 *
 * WHY THIS IS SHORT, AND WHAT IT REPLACED.
 *
 * A cash sale is a counter transaction. The customer is standing in front of the
 * dealer with the money; there is no lender to satisfy, no KYC to verify and no
 * admin approval step anywhere on the cash path. The chat used to run it as if
 * there were: product *category* tag → vehicle reg → Aadhaar front + Aadhaar
 * back + PAN → "you can complete the rest on the dealer portal". Four steps, three
 * document uploads, and it still did not sell anything — no serial was captured,
 * no stock moved, no warranty existed. The dealer then re-did the whole order on
 * the web.
 *
 * Now it captures the two things a receipt needs and sells:
 *
 *   name → vehicle registration → battery (from live stock) → charger (optional)
 *        → confirmCashSale(): inventory SOLD, warranty + after-sales created,
 *          lead closed.
 *
 * WHY THE NAME IS ASKED EXPLICITLY. It used to arrive as a side effect of
 * reading the Aadhaar. Drop the Aadhaar and nothing fills `leads.full_name`, so
 * the warranty and after-sales rows — which a customer may hold for years — would
 * be created against a phone number and nothing else. One question is cheaper
 * than three document uploads and gets the same field.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED. Aadhaar and PAN. There is no lender, no
 * credit decision and no DPDP consent on a cash sale, so the identity documents
 * were being collected for a verification that never runs. (The duplicate-guard
 * that finance applies to documents was already disabled for cash — a customer
 * may legitimately buy on cash repeatedly.)
 *
 * The picker and the sale itself live in ./dispatch-flow, shared with the
 * finance path so the two can never disagree about stock or price.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads } from "@/lib/db/schema";

import type { ActiveDealer } from "./customer-lead";
import { askBattery } from "./dispatch-flow";
import { registerLeadState } from "./lead-states";
import { loadSession, reply, setSession, type SessionRow } from "./session-store";
import type { InboundEvent } from "./types";

export const DC_CASH_NAME = "DC_CASH_NAME";
export const DC_CASH_RC = "DC_CASH_RC";

/** Longest name we will store; the column is far wider, this is a sanity bound. */
const MAX_NAME = 120;

function leadIdOf(session: SessionRow): string | undefined {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId;
}

/**
 * Entry from `onLeadPayment` once the customer chose Cash.
 *
 * The lead row already exists by this point (`createCustomerLead` runs inside
 * `onLeadPayment`), so everything below is an UPDATE.
 */
export async function startCashSale(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: DC_CASH_NAME });
  await reply(
    session,
    "💵 *Cash sale*\n\nWhat's the customer's *full name*?",
  );
}

/** DC_CASH_NAME — the one identity field a warranty needs. */
async function onCashName(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const name = (event.text ?? "").trim().replace(/\s+/g, " ");
  // Two characters is not a name, and a tapped button id is not one either.
  if (name.length < 2 || name.length > MAX_NAME || /^[a-z]{2,}_/i.test(name)) {
    await reply(session, "Please type the customer's *full name*.");
    return;
  }

  const leadId = leadIdOf(await loadSession(session.id));
  if (!leadId) {
    await reply(session, "I've lost track of this lead. Please send *hi* to start again.");
    return;
  }

  // Both columns: `full_name` is what the sale and the warranty read,
  // `owner_name` is what several lead list views fall back to.
  await db
    .update(leads)
    .set({ full_name: name, owner_name: name, updated_at: new Date() })
    .where(eq(leads.id, leadId));

  await askVehicleRc(session);
}

/** DC_CASH_RC prompt. Exported so a resumed draft can re-enter here. */
export async function askVehicleRc(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: DC_CASH_RC });
  await reply(
    session,
    "🚗 What's the *vehicle registration number*? (e.g. HR 35 A 7898)",
  );
}

/**
 * DC_CASH_RC — the registration the battery is fitted to.
 *
 * Same validation the old cash flow used; only the next step changed — it opens
 * the stock picker instead of asking for three documents.
 */
async function onCashRc(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const rc = (event.text ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (rc.length < 6 || !/^[A-Z0-9]+$/.test(rc)) {
    await reply(
      session,
      "Please send a valid *vehicle registration number* (e.g. HR 35 A 7898).",
    );
    return;
  }

  const leadId = leadIdOf(await loadSession(session.id));
  if (!leadId) {
    await reply(session, "I've lost track of this lead. Please send *hi* to start again.");
    return;
  }

  await db
    .update(leads)
    .set({ vehicle_rc: rc, updated_at: new Date() })
    .where(eq(leads.id, leadId));

  // Straight into the shared picker. No category filter is applied for a cash
  // lead — nothing has tagged one yet, and showing the dealer their whole
  // sellable stock is the right answer at a counter.
  await askBattery(session, leadId, dealer, 0);
}

registerLeadState(DC_CASH_NAME, onCashName);
registerLeadState(DC_CASH_RC, onCashRc);
