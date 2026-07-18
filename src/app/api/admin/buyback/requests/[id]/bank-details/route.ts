/**
 * PATCH /api/admin/buyback/requests/:id/bank-details   (E-193/R4)
 *
 * Correct the dealer's payout bank details (name / account / IFSC / beneficiary)
 * on their `accounts` row, so the RazorpayX payout route has something valid to
 * pay to. UNLIKE the payout route this is NOT gated on payoutsConfigured() — it
 * makes no provider call and touches only the DB, and fixing wrong bank data must
 * be possible whether or not online payouts are switched on.
 *
 * The full account number NEVER leaves this route: the audit row and the response
 * both carry only the masked view (`••••1234`). The IFSC is not secret and is
 * returned in full.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { loadDealerBank, maskAccount } from "@/lib/buyback/parties";
import { dealHeader } from "@/lib/buyback/queries";
import { recordActivity } from "@/lib/buyback/transition";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

const bodySchema = z.object({
  bank_name: z.string().trim().min(1).max(120).optional(),
  bank_account_number: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/, "The account number must be 6 to 20 digits."),
  ifsc_code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s), "That is not a valid IFSC code."),
  bank_beneficiary_name: z.string().trim().min(1).max(140).optional(),
});

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");
    const entityId = header.dealer_entity_id;

    // A missing accounts row is a 404 — there is nothing to correct.
    const existing = await loadDealerBank(entityId);
    if (!existing) throw new NotFoundError("Dealer account not found.");

    await db.transaction(async (tx) => {
      // Optional fields left absent keep their current value (COALESCE), so a PATCH
      // that only fixes the account number does not blank the beneficiary name.
      await tx.execute(sql`
        UPDATE accounts
           SET bank_name = COALESCE(${body.bank_name ?? null}, bank_name),
               bank_account_number = ${body.bank_account_number},
               ifsc_code = ${body.ifsc_code},
               bank_beneficiary_name = COALESCE(${body.bank_beneficiary_name ?? null}, bank_beneficiary_name),
               updated_at = now()
         WHERE id = ${entityId}
      `);

      await recordActivity({
        tx,
        requestId: request.id,
        dealId: header.deal_id,
        actor: { id: actor.id, role: "admin" },
        action: "bank_details_updated",
        after: {
          // MASKED only — the full number never enters the audit trail.
          account_masked: maskAccount(body.bank_account_number),
          ifsc_code: body.ifsc_code,
        },
      });
    });

    const updated = await loadDealerBank(entityId);
    return successResponse({ ok: true, dealer_bank: updated?.view ?? null });
  },
);
