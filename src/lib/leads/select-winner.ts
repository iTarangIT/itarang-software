/**
 * Choosing the winning lender — the write, lifted out of the dealer route.
 *
 * WHY THIS EXISTS. Same reason as `submit-step4.ts` and `negotiate-offer.ts`:
 * the customer can now accept an offer from inside their WhatsApp chat, where
 * there is no Supabase session for `requireRole("dealer")`. The caller answers
 * *who may accept*; this answers *what accepting does*.
 *
 * WHAT IT MUST NOT LOSE. Two rules here have already been got wrong once and are
 * load-bearing:
 *   - A lender that was CLOSED by the borrower, or that DECLINED, did not lose
 *     to this winner. Sweeping it to 'not_selected' erases the only record of
 *     why that conversation ended (E-245) — hence the notInArray.
 *   - The lead must advance to 'awaiting_enach', because the winner-only E-NACH
 *     track keys off `getWinningAssignment(status='selected')`. Without it the
 *     lead is selected and stuck.
 */

import { and, eq, ne, notInArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { sendNotSelectedEmail } from "@/lib/email/sendManualHandoffEmail";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";
import { dealerDisplayName } from "@/lib/notifications/emit";
import { notifyWinnerSelected } from "@/lib/notifications/events";
import { OfferActionError } from "@/lib/leads/negotiate-offer";

export interface SelectWinnerResult {
  leadId: string;
  winnerNbfcId: number;
  kycStatus: "awaiting_enach";
}

/**
 * Make one routed lender the winner and close out the rest.
 *
 * The caller owns authorisation. Throws `OfferActionError` for anything the
 * borrower should be told about (wrong lender, no offer yet); anything else is a
 * genuine failure and propagates. Notifications are best-effort and never throw.
 */
export async function selectOfferWinner(opts: {
  leadId: string;
  nbfcId: number;
}): Promise<SelectWinnerResult> {
  const { leadId, nbfcId: chosenNbfcId } = opts;

  const assignments = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      status: nbfcLeadAssignments.status,
    })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));

  const chosen = assignments.find((a) => a.nbfc_id === chosenNbfcId);
  if (!chosen) {
    throw new OfferActionError(
      "That lender is not among this lead's lenders.",
    );
  }
  if (chosen.status !== "offer_submitted") {
    throw new OfferActionError(
      `That lender has not made a firm offer yet (status '${chosen.status}'). A lender can only be chosen from submitted offers.`,
    );
  }

  const now = new Date();
  const loserNbfcIds = assignments
    .filter(
      (a) =>
        a.nbfc_id !== chosenNbfcId &&
        // Already told they were out — see the notInArray in the sweep below.
        a.status !== "withdrawn" &&
        a.status !== "declined",
    )
    .map((a) => a.nbfc_id);

  await db.transaction(async (tx) => {
    await tx
      .update(nbfcLeadAssignments)
      .set({
        status: "selected",
        decided_at: now,
        decision_reason: "customer_selected",
        updated_at: now,
      })
      .where(eq(nbfcLeadAssignments.id, chosen.id));

    await tx
      .update(nbfcLeadAssignments)
      .set({
        status: "not_selected",
        decided_at: now,
        decision_reason: "customer_picked_other",
        updated_at: now,
      })
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          ne(nbfcLeadAssignments.nbfc_id, chosenNbfcId),
          // E-245 — a lender the borrower already CLOSED (or that declined) did
          // not lose to this winner, and overwriting it with 'not_selected'
          // would erase the only record of why that conversation ended.
          notInArray(nbfcLeadAssignments.status, ["withdrawn", "declined"]),
        ),
      );

    await tx
      .update(leads)
      .set({ kyc_status: "awaiting_enach", updated_at: now })
      .where(eq(leads.id, leadId));
  });

  // Notify each losing NBFC (best-effort — must not fail the selection).
  if (loserNbfcIds.length > 0) {
    try {
      const [leadName] = await db
        .select({ full_name: leads.full_name, owner_name: leads.owner_name })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      const customerName = leadName?.full_name ?? leadName?.owner_name ?? "the customer";
      for (const loserId of loserNbfcIds) {
        const [row] = await db
          .select({ short_name: nbfc.short_name, email: nbfc.primary_contact_email })
          .from(nbfc)
          .where(eq(nbfc.id, loserId))
          .limit(1);
        if (row?.email) {
          await sendNotSelectedEmail({
            toEmails: [row.email],
            leadId,
            nbfcName: row.short_name ?? "NBFC",
            customerName,
          });
        }
      }
    } catch (err) {
      console.error("[select-winner] loser notification failed:", err);
    }
  }

  // In-app: the winner is told to proceed, every loser is told the lead is gone,
  // and the admin sees the decision. The loser email above stays — it reaches
  // NBFC contacts who have no portal login.
  try {
    const [winnerNbfc] = await db
      .select({
        tenant_id: nbfc.tenant_id,
        legal_name: nbfc.legal_name,
        short_name: nbfc.short_name,
      })
      .from(nbfc)
      .where(eq(nbfc.id, chosenNbfcId))
      .limit(1);
    if (winnerNbfc?.tenant_id) {
      await notifyWinnerSelected({
        leadId,
        winnerTenantId: winnerNbfc.tenant_id,
        winnerName: winnerNbfc.legal_name || winnerNbfc.short_name || "the lender",
      });

      // E-276 — contact-email copy to the winning NBFC (+ global monitoring CC).
      const [leadName] = await db
        .select({
          full_name: leads.full_name,
          owner_name: leads.owner_name,
          dealer_id: leads.dealer_id,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      const winnerCustomer = leadName?.full_name ?? leadName?.owner_name ?? "the customer";
      sendNbfcEventEmail({
        tenantId: winnerNbfc.tenant_id,
        leadId,
        subject: `iTarang — Your offer was accepted (Lead ${leadId})`,
        eventLabel: `Customer ${winnerCustomer} has accepted the financing offer from ${
          winnerNbfc.legal_name || winnerNbfc.short_name || "your NBFC"
        } on Lead ${leadId}.`,
        customerName: winnerCustomer,
        dealerName: await dealerDisplayName(leadName?.dealer_id),
        extraRows: [["Selected lender", winnerNbfc.legal_name || winnerNbfc.short_name]],
        bodyHtml: `<p>Update: the lead has moved to <b>awaiting E-NACH</b>. Please proceed with the next steps (E-NACH mandate, agreement, sanction) in your NBFC dashboard.</p>`,
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[select-winner] winner notification failed:", err);
  }

  return { leadId, winnerNbfcId: chosenNbfcId, kycStatus: "awaiting_enach" };
}
