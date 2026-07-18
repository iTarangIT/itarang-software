/**
 * POST /api/admin/buyback/requests/:id/settlements   (BRD M13 / U9 / U10)
 *
 * Records one leg of the money:
 *   TXN-1024-D   OUT   iTarang paid the dealer
 *   TXN-1024-V   IN    the vendor paid iTarang
 *
 * Both closed ⇒ SETTLED (fired inside the transaction that closes the pair).
 *
 * RECORDED, NEVER EXECUTED (BRD §10). Nothing here talks to a bank. Razorpay in
 * this codebase is inbound-collection-only — createPaymentQr, e-mandate, virtual
 * accounts — and cannot pay a dealer out. An admin pays out of band and records
 * it here, with proof.
 *
 * THE AMOUNT IS NOT TAKEN FROM THE CLIENT. It is derived from deal_line_locks:
 * the dealer is paid Σ qty × dealer_price, the vendor pays Σ qty × vendor_price.
 * If an admin could type the amount, the ledger would stop reconciling against
 * the locks and M14's invariant would quietly become false. What the admin
 * supplies is EVIDENCE — the bank reference, the date, the proof — not the figure.
 *
 * "Manual settlement without proof rejected" (M13 AC) is enforced by a CHECK
 * constraint in E-187, so it holds even for a route that forgets, a script, or a
 * backfill. The Zod schema below is the polite version of the same rule.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { settlementTransactions } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import { inr } from "@/lib/buyback/format";
import {
  dealMoney,
  dealerPayout,
  groupTxnId,
  legSubId,
  settlementsForDeal,
  vendorReceipt,
} from "@/lib/buyback/money";
import { assertNoInflightGateway } from "@/lib/buyback/gateway";
import { assertPayoutAllowed } from "@/lib/buyback/pickup";
import { dealHeader } from "@/lib/buyback/queries";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const bodySchema = z.object({
  leg: z.enum(["DEALER", "VENDOR"]),
  /**
   * MANUAL is the only method this route may mint. STATEMENT rows are created
   * server-side by the statement-confirm route; API rows are minted only by a
   * terminal gateway success (applyGatewayOutcome). A client that could post
   * either here would forge a settlement the ledger cannot trace back to its
   * evidence — so the method is pinned, not merely defaulted.
   */
  method: z.literal("MANUAL").default("MANUAL"),
  /** UTR / bank reference. Mandatory for MANUAL — a payment with no reference is untraceable. */
  txn_ref: z.string().min(1).max(120).optional(),
  txn_date: z.string(),
  /** S3 key of the payment proof, uploaded via the presign route. Mandatory for MANUAL. */
  proof_s3: z.string().min(1).optional(),
  note: z.string().max(1000).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    if (body.method === "MANUAL" && (!body.proof_s3 || !body.txn_ref)) {
      // The DB refuses this too (settlement_manual_needs_proof). This message is
      // just the human-readable half.
      throw new ValidationError(
        "A manual settlement needs a bank reference AND proof of payment. A payment with no evidence is not a payment — it is a claim.",
        { code: "PROOF_REQUIRED" },
      );
    }

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");
    if (header.status !== "INVOICE_APPROVED") {
      throw new TransitionError(
        header.status === "SETTLED" || header.status === "CLOSED"
          ? "This deal is already settled."
          : `The deal is ${header.status}. Money cannot move until the invoice is approved.`,
      );
    }

    const money = await dealMoney(header.deal_id);
    const receipt = vendorReceipt(money);

    // Server-derived. The admin evidences a payment; they do not name its size.
    const amount = body.leg === "DEALER" ? dealerPayout(money) : receipt;
    if (amount === null || amount <= 0) {
      throw new ValidationError(
        "This deal has no agreed vendor price, so the receipt amount cannot be derived.",
      );
    }

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      // M05 AC — "dealer WhatsApp ack on variance BEFORE payout."
      //
      // If we collected fewer batteries than the dealer declared, we owe them
      // less than their invoice says, and they have not yet agreed to the count.
      // Paying out now means arguing about money that has already left the
      // building. Refuses the DEALER leg only: the vendor's receipt has nothing to
      // do with what the dealer handed over.
      await assertPayoutAllowed(deal.id, body.leg, tx);

      // A manual settlement must not collide with an online one still in flight
      // (M13 race guard). A queued RazorpayX payout cannot be recalled; recording
      // this leg by hand while it lands is exactly how a dealer gets paid twice.
      await assertNoInflightGateway(deal.id, body.leg, tx);

      const subId = legSubId(request.request_no, body.leg);

      // UNIQUE(leg_sub_id) would refuse this anyway; catching it here gives a
      // sentence rather than a constraint-violation stack trace.
      const existing = await settlementsForDeal(deal.id, tx);
      if (existing.some((s) => s.leg_sub_id === subId)) {
        throw new ValidationError(
          `${subId} is already recorded. A settlement cannot be recorded twice — that is how a dealer gets paid twice.`,
        );
      }

      await tx.insert(settlementTransactions).values({
        deal_id: deal.id,
        group_txn_id: groupTxnId(request.request_no),
        leg_sub_id: subId,
        leg: body.leg,
        direction: body.leg === "DEALER" ? "OUT" : "IN",
        method: body.method,
        txn_ref: body.txn_ref ?? null,
        amount: amount.toString(),
        txn_date: body.txn_date,
        proof_s3: body.proof_s3 ?? null,
        note: body.note ?? null,
        recorded_by: actor.id,
        // Recorded = closed. There is no partial payment in v1: the amount is
        // derived from the locks, so it is either paid in full or not recorded.
        closed_at: new Date(),
      });

      const after = await settlementsForDeal(deal.id, tx);
      const closed = new Set(after.filter((s) => s.closed_at).map((s) => s.leg));
      const bothClosed = closed.has("DEALER") && closed.has("VENDOR");

      // The party who was actually paid is the one told. A dealer must never be
      // notified that a VENDOR paid us — and must never see the vendor's figure.
      const payload =
        body.leg === "DEALER"
          ? {
              party: "DEALER" as const,
              channel: "WHATSAPP" as const,
              payload: {
                request_no: request.request_no,
                amount,
                txn_ref: body.txn_ref ?? null,
                kind: "dealer_paid",
              },
            }
          : {
              party: "ADMIN" as const,
              channel: "PORTAL" as const,
              payload: { request_no: request.request_no, amount, kind: "vendor_receipt" },
            };

      const first = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "record_settlement",
        actor: { id: actor.id, role: "admin" },
        after: { leg: body.leg, leg_sub_id: subId, amount, method: body.method },
        fanOut: [{ ...payload, discriminator: subId }],
      });

      if (!bothClosed) {
        return { status: first.to, settled: false, amount, sub_id: subId };
      }

      // The pair is complete. A SECOND transition, in the same transaction —
      // recording the money and settling the deal are two distinct facts, and the
      // audit log should say both happened.
      const settled = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: "INVOICE_APPROVED",
        offerVersion: deal.offer_version,
        action: "settle",
        actor: { id: actor.id, role: "admin" },
        after: {
          group_txn_id: groupTxnId(request.request_no),
          paid_out: dealerPayout(money),
          received: receipt,
          realised_margin: (receipt ?? 0) - dealerPayout(money),
        },
        notificationPayload: {
          request_no: request.request_no,
          realised_margin: (receipt ?? 0) - dealerPayout(money),
        },
      });

      return { status: settled.to, settled: true, amount, sub_id: subId };
    });

    return successResponse({
      request_id: request.id,
      status: outcome.status,
      leg_sub_id: outcome.sub_id,
      amount: outcome.amount,
      amount_label: inr(outcome.amount),
      both_legs_settled: outcome.settled,
    });
  },
);
