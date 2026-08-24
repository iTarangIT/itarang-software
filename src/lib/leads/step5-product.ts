/**
 * Step-5 product save — the write, lifted out of the dealer route.
 *
 * WHY THIS EXISTS. Since the Step-4/Step-5 split this is where the actual stock
 * is committed: Step 4 means "send this customer to the lenders" and carries no
 * serial and no price. The customer now makes that choice inside their WhatsApp
 * chat, where there is no Supabase session for `requireRole("dealer")`. Same
 * split as `submit-step4.ts` — the caller owns authorisation and the
 * `loan_sanctioned` eligibility check; this owns the row.
 *
 * TWO BEHAVIOURS THAT MUST NOT BE RE-DERIVED BY A SECOND CALLER:
 *
 *  - **It does not reserve inventory.** Reservation happens inside the
 *    `confirm-dispatch` transaction, so a lead only locks stock at the moment it
 *    ships. Between saving here and dispatching, the serial is still available
 *    to another lead — a known, accepted oversell window. Anything that reserves
 *    here would take stock out of circulation for every abandoned cart.
 *
 *  - **Saving invalidates any outstanding OTP.** The customer approves a
 *    specific price; changing the battery or the margin afterwards must force a
 *    fresh code rather than silently re-point an approval already given.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { otpConfirmations, productSelections } from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";
import {
  productSelectionColumns,
  type Step5ProductSelectionBody,
} from "@/lib/leads/productSelectionSchema";

export interface Step5SaveResult {
  productSelectionId: string;
  batterySerial: string;
  chargerSerial: string | null;
  finalPrice: number;
  /**
   * True when the product changed after an OTP was already sent — the UI uses
   * it to explain why the OTP box reset.
   */
  otpInvalidated: boolean;
}

/**
 * Persist the chosen stock onto the lead's `product_selections` row.
 *
 * The caller owns authorisation and must already have checked that the lead is
 * `loan_sanctioned`.
 */
export async function saveStep5ProductSelection(opts: {
  leadId: string;
  body: Step5ProductSelectionBody;
  /** `users.id` recorded as `submitted_by` on the defensive insert path. */
  submittedBy: string;
  /** Lead defaults used only when no Step-4 row exists to update. */
  lead: { product_category_id: string | null; product_type_id: string | null };
}): Promise<Step5SaveResult> {
  const { leadId, body, submittedBy, lead } = opts;

  const now = new Date();
  const columns = productSelectionColumns(body);

  const [existing] = await db
    .select({
      id: productSelections.id,
      battery_serial: productSelections.battery_serial,
    })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);

  const result = await db.transaction(async (tx) => {
    let selectionId: string;

    if (existing) {
      selectionId = existing.id;
      await tx
        .update(productSelections)
        .set({
          ...columns,
          category: body.category ?? undefined,
          model_number: body.modelNumber ?? undefined,
          updated_at: now,
        })
        .where(eq(productSelections.id, existing.id));
    } else {
      // Defensive: a sanctioned lead should always have the row Step 4
      // inserted. Create one rather than throw so nobody is stranded on a lead
      // whose Step-4 row was cleaned up out from under them.
      selectionId = await generateId("PS");
      await tx.insert(productSelections).values({
        id: selectionId,
        lead_id: leadId,
        ...columns,
        category: body.category || lead.product_category_id,
        model_number: body.modelNumber || lead.product_type_id,
        payment_mode: "finance",
        admin_decision: "pending",
        submitted_by: submittedBy,
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    // Any OTP the customer has not yet spent approved a different number.
    // Expire it so `verify-otp` rejects it and a fresh one has to be sent.
    await tx
      .update(otpConfirmations)
      .set({ expires_at: now })
      .where(
        and(
          eq(otpConfirmations.lead_id, leadId),
          eq(otpConfirmations.otp_type, "dispatch_confirmation"),
          eq(otpConfirmations.is_used, false),
        ),
      );

    return { selectionId };
  });

  return {
    productSelectionId: result.selectionId,
    batterySerial: body.batterySerial,
    chargerSerial: body.chargerSerial ?? null,
    finalPrice: body.finalPrice,
    otpInvalidated: !!existing && existing.battery_serial !== body.batterySerial,
  };
}
