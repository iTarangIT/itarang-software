/**
 * POST /api/admin/buyback/requests/:id/settlements/payout   (E-193/R4)
 *
 * Pay the dealer their leg of the money via a RazorpayX composite payout — the
 * online sibling of the manual settlements route. Where the manual route records
 * a payout an admin made out of band, this one MAKES it and records the terminal
 * result as a settlement, through the SAME transactional core (applyGatewayOutcome
 * in lib/buyback/gateway.ts) so a dealer paid online and a dealer paid by hand are
 * indistinguishable to the ledger.
 *
 * THE AMOUNT IS NEVER TAKEN FROM THE CLIENT. The route body carries no figure at
 * all — the payout is Σ qty × dealer_price, derived from deal_line_locks server
 * side at initiation and re-derived AGAIN on the terminal success. The admin
 * clicks a button; they do not name a number.
 *
 * DARK UNLESS CONFIGURED: with the three RAZORPAYX_* vars unset, payoutsConfigured()
 * is false and this 409s before touching the DB or the provider. The full account
 * number reaches the RazorpayX fund_account and NOTHING else — never a response,
 * a log, or an activity row (masked to the last four there).
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackGatewayTransactions } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import {
  applyGatewayOutcome,
  assertNoInflightGateway,
  attachProviderRef,
  gatewayTxnView,
  getGatewayTxn,
  mapPayoutStatus,
} from "@/lib/buyback/gateway";
import { dealMoney, dealerPayout, legSubId, settlementsForDeal } from "@/lib/buyback/money";
import { loadDealerBank, isValidIfsc } from "@/lib/buyback/parties";
import { assertPayoutAllowed } from "@/lib/buyback/pickup";
import { dealHeader } from "@/lib/buyback/queries";
import { loadDealForUpdate, recordActivity } from "@/lib/buyback/transition";
import { createCompositePayout, payoutsConfigured, razorpayxErrorMessage } from "@/lib/razorpayx";

export const runtime = "nodejs";

/** A Postgres unique-violation (the gateway_txn_one_inflight_per_leg race). */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();

    // Dark unless the RazorpayX keys are present — before any DB or provider work.
    if (!payoutsConfigured()) {
      throw new HttpError("RazorpayX is not configured for payouts.", 409);
    }

    const request = await loadAnyRequest(requestId);
    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    // The dealer's payout bank. The RAW account number is used ONLY for the
    // fund_account below; the masked view is all that ever reaches a response/log.
    const bank = await loadDealerBank(header.dealer_entity_id);
    if (!bank) throw new NotFoundError("Dealer account not found.");

    const missing: string[] = [];
    if (!bank.account_number || !bank.account_number.trim()) missing.push("bank_account_number");
    if (!bank.ifsc_code || !bank.ifsc_code.trim()) missing.push("ifsc_code");
    if (missing.length > 0) {
      throw new ValidationError(
        "The dealer's payout bank details are incomplete — add them before paying out.",
        { code: "BANK_DETAILS_INCOMPLETE", missing },
      );
    }
    if (!isValidIfsc(bank.ifsc_code)) {
      throw new ValidationError("The dealer's IFSC code is not valid.", {
        code: "BANK_DETAILS_INCOMPLETE",
        missing: ["ifsc_code"],
      });
    }

    // --- Tx-1: mint the in-flight attempt. Its amount is server-derived and the
    //     partial unique index makes a double-clicked payout a constraint error.
    let txn: { rowId: string; amount: number };
    try {
      txn = await db.transaction(async (tx) => {
        const deal = await loadDealForUpdate(tx, request.id);
        if (!deal) throw new NotFoundError("Deal not found.");
        if (deal.status !== "INVOICE_APPROVED") {
          throw new TransitionError(
            deal.status === "SETTLED" || deal.status === "CLOSED"
              ? "This deal is already settled."
              : `The deal is ${deal.status}. A payout cannot start until the invoice is approved.`,
          );
        }

        // M05 — no dealer payout while a count variance sits unacknowledged.
        await assertPayoutAllowed(deal.id, "DEALER", tx);

        const subId = legSubId(request.request_no, "DEALER");
        const existing = await settlementsForDeal(deal.id, tx);
        if (existing.some((s) => s.leg_sub_id === subId)) {
          throw new ValidationError(
            `${subId} is already recorded. A settlement cannot be recorded twice — that is how a dealer gets paid twice.`,
          );
        }

        // No online attempt already in flight for this leg (the app-level half of
        // the race guard; the DB partial index is the last line for a true race).
        await assertNoInflightGateway(deal.id, "DEALER", tx);

        const money = await dealMoney(deal.id, tx);
        const amount = dealerPayout(money);
        if (amount === null || amount <= 0) {
          throw new ValidationError("This deal has no dealer payout amount to pay out.");
        }

        const [ins] = await tx
          .insert(buybackGatewayTransactions)
          .values({
            deal_id: deal.id,
            leg: "DEALER",
            direction: "OUT",
            kind: "PAYOUT",
            provider: "RAZORPAYX",
            amount: amount.toString(),
            status: "INITIATED",
            initiated_by: actor.id,
          })
          .returning({ id: buybackGatewayTransactions.id });

        await recordActivity({
          tx,
          requestId: request.id,
          dealId: deal.id,
          actor: { id: actor.id, role: "admin" },
          action: "gateway_payout_initiated",
          after: {
            gateway_txn_id: ins.id,
            amount,
            // MASKED only — the full number never enters the audit trail.
            account_masked: bank.view.account_masked,
            ifsc_code: bank.ifsc_code,
          },
        });

        return { rowId: ins.id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(
          "A payout for this leg is already in flight. Wait for it to land or fail before trying again.",
          409,
        );
      }
      throw err;
    }

    const { rowId, amount } = txn;

    // Uphold RazorpayX's documented-but-unenforced caller bounds BEFORE the call.
    const amountPaise = Math.round(amount * 100);
    if (amountPaise < 100) {
      await applyGatewayOutcome(rowId, {
        type: "failure",
        status: "FAILED",
        reason: "amount below the ₹1 RazorpayX minimum",
        raw: null,
      });
      throw new ValidationError("The payout amount is below the minimum RazorpayX will accept.");
    }

    const notes: Record<string, string> = {
      itarang_purpose: "buyback_dealer_payout",
      itarang_gateway_txn_id: rowId,
      deal_id: header.deal_id,
      request_no: request.request_no,
    };

    // --- Provider call (outside any transaction — never hold a row lock across a
    //     network call). A throw marks the attempt FAILED (retry is a fresh POST,
    //     which passes assertNoInflightGateway) and surfaces 502.
    let payout;
    try {
      payout = await createCompositePayout({
        amountPaise,
        beneficiary: {
          name: bank.beneficiary ?? bank.business_entity_name,
          ifsc: bank.ifsc_code!.toUpperCase(),
          accountNumber: bank.account_number!,
        },
        contact: {
          name: header.dealer_name ?? bank.business_entity_name,
          email: bank.contact_email,
          phone: bank.contact_phone,
        },
        referenceId: rowId,
        narration: `ITARANG BB ${request.request_no}`,
        notes,
        idempotencyKey: rowId,
      });
    } catch (err) {
      const message = razorpayxErrorMessage(err);
      await applyGatewayOutcome(rowId, {
        type: "failure",
        status: "FAILED",
        reason: message,
        raw: null,
      });
      throw new HttpError(message, 502);
    }

    // Stamp the payout id, then let the shared mapper decide the outcome — test
    // mode can return `processed` synchronously, which mints the settlement here.
    await attachProviderRef(rowId, { providerRef: payout.id, raw: payout.raw });
    const outcome = mapPayoutStatus(payout.status, payout);
    if (outcome) await applyGatewayOutcome(rowId, outcome);

    const fresh = await getGatewayTxn(rowId);
    return successResponse({ ok: true, txn: fresh ? gatewayTxnView(fresh) : null });
  },
);
