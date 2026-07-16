/**
 * POST /api/admin/buyback/statements/rows/:rowId/confirm            (M13 / U9)
 * POST /api/admin/buyback/statements/rows/:rowId/confirm?ignore=1
 *
 * Turns ONE bank-statement row into ONE settlement — or dismisses it.
 *
 * This is the only place the STATEMENT method creates money-leg facts, and it is
 * built around a single idea: THE STATEMENT EVIDENCES A PAYMENT, IT DOES NOT GET
 * TO STATE WHAT WE OWED.
 *
 * So the amount is re-derived from deal_line_locks — exactly as the MANUAL route
 * derives it — and the row's own figure is used only to ASSERT against it. A bank
 * row that does not equal what we owe is not a settlement; it is a question, and
 * it is refused rather than reconciled. Without that check the ledger would stop
 * reconciling against the locks the first time a bank fee shaved ₹12 off a
 * payout, and M14's invariant would quietly become false.
 *
 * The settlement is written with method='STATEMENT', `statement_row_id` and NO
 * proof file. That is legitimate: E-187's CHECK (settlement_manual_needs_proof)
 * demands a proof file only for MANUAL, precisely so this path does not have to
 * fabricate one. The traceability that a proof file would have given us is given
 * instead by statement_row_id → the imported row → the archived statement.
 *
 * ?ignore=1 exists because a real bank statement is mostly not ours: rent,
 * salaries, GST, the electricity bill. Marking those IGNORED is what lets the
 * unmatched queue mean "unreconciled" instead of "everything the bank did".
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { settlementTransactions } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import { inr } from "@/lib/buyback/format";
import { assertNoInflightGateway } from "@/lib/buyback/gateway";
import {
  dealMoney,
  dealerPayout,
  groupTxnId,
  legSubId,
  settlementsForDeal,
  vendorReceipt,
} from "@/lib/buyback/money";
import { assertPayoutAllowed } from "@/lib/buyback/pickup";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import type { BuybackTx } from "@/lib/buyback/tx";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Omit both to accept whatever the matcher suggested. */
  deal_id: z.string().uuid().optional(),
  leg: z.enum(["DEALER", "VENDOR"]).optional(),
  note: z.string().max(1000).optional(),
});

interface RowLock {
  id: string;
  import_id: string;
  txn_date: string;
  amount: string;
  txn_ref: string | null;
  status: "UNMATCHED" | "SUGGESTED" | "MATCHED" | "IGNORED";
  suggested_deal_id: string | null;
  suggested_leg: "DEALER" | "VENDOR" | null;
}

/**
 * Reads the statement row and locks it FOR UPDATE.
 *
 * The lock is the thing that stops two admins confirming the same row into two
 * settlements. UNIQUE(leg_sub_id) would catch the second one anyway, but only
 * after it had already written a transition — this refuses it before anything
 * moves.
 */
async function lockRow(tx: BuybackTx, rowId: string): Promise<RowLock | null> {
  const rows = (await tx.execute(sql`
    SELECT id, import_id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount,
           txn_ref, status, suggested_deal_id, suggested_leg
    FROM bank_statement_rows
    WHERE id = ${rowId}::uuid
    FOR UPDATE
  `)) as unknown as RowLock[];

  return rows[0] ?? null;
}

const paise = (n: number) => Math.round(n * 100);

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ rowId: string }> }) => {
    const { rowId } = await ctx.params;
    const actor = await requireBuybackAdmin();

    const ignore = new URL(req.url).searchParams.get("ignore") === "1";
    // An empty body is the "accept the suggestion" case, and JSON.parse hates it.
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    // ---- The dismissal path -------------------------------------------------
    if (ignore) {
      const outcome = await db.transaction(async (tx) => {
        const row = await lockRow(tx, rowId);
        if (!row) throw new NotFoundError("Statement row not found.");
        if (row.status === "MATCHED") {
          // Ignoring a matched row would orphan a settlement from its evidence.
          throw new ValidationError(
            "This row is already matched to a settlement. It cannot be ignored — reverse the settlement first.",
          );
        }

        await tx.execute(sql`
          UPDATE bank_statement_rows
             SET status = 'IGNORED',
                 suggested_deal_id = NULL,
                 suggested_leg = NULL,
                 matched_by = ${actor.id}::uuid,
                 matched_at = now()
           WHERE id = ${rowId}::uuid
        `);

        return { status: "IGNORED" as const };
      });

      return successResponse({ row_id: rowId, status: outcome.status });
    }

    // ---- The settlement path ------------------------------------------------
    const outcome = await db.transaction(async (tx) => {
      const row = await lockRow(tx, rowId);
      if (!row) throw new NotFoundError("Statement row not found.");
      if (row.status === "MATCHED") {
        throw new ValidationError(
          "This row is already matched. A bank row evidences one payment, not two.",
        );
      }

      const dealId = body.deal_id ?? row.suggested_deal_id;
      const leg = body.leg ?? row.suggested_leg;
      if (!dealId || !leg) {
        throw new ValidationError(
          "There is no suggestion on this row. Say which deal and which leg it settles.",
        );
      }

      // The SIGN is not a formality — it is the only thing distinguishing money
      // we sent from money we received, and a row with the right number facing
      // the wrong way is somebody else's transaction.
      const rowAmount = Number(row.amount);
      if (leg === "DEALER" && rowAmount >= 0) {
        throw new ValidationError(
          "A dealer payout is money leaving iTarang — a debit. This row is a credit, so it cannot be one.",
        );
      }
      if (leg === "VENDOR" && rowAmount <= 0) {
        throw new ValidationError(
          "A vendor receipt is money arriving at iTarang — a credit. This row is a debit, so it cannot be one.",
        );
      }

      const [deal] = (await tx.execute(sql`
        SELECT br.id AS request_id, br.request_no
        FROM buyback_deals bd
        JOIN buyback_requests br ON br.id = bd.request_id
        WHERE bd.id = ${dealId}::uuid
      `)) as unknown as Array<{ request_id: string; request_no: string }>;

      if (!deal) throw new NotFoundError("Deal not found.");

      const locked = await loadDealForUpdate(tx, deal.request_id);
      if (!locked) throw new NotFoundError("Deal not found.");
      if (locked.status !== "INVOICE_APPROVED") {
        throw new TransitionError(
          locked.status === "SETTLED" || locked.status === "CLOSED"
            ? `${deal.request_no} is already settled.`
            : `${deal.request_no} is ${locked.status}. Money cannot move until the invoice is approved.`,
        );
      }

      // M05 AC — "dealer WhatsApp ack on variance BEFORE payout."
      //
      // THIS IS NOT OPTIONAL HERE JUST BECAUSE THE MONEY ARRIVED VIA A BANK
      // STATEMENT. A gate that only guards the manual route is not a gate: an
      // admin who found the payout blocked would simply reconcile the same dealer
      // from the statement screen and pay them anyway, without the dealer ever
      // agreeing to the count. Every path that creates a DEALER settlement must
      // pass through here.
      await assertPayoutAllowed(locked.id, leg, tx);

      // Same M13 race guard as the manual route: a bank-statement match must not
      // settle a leg that an online payout/link is still resolving, or the money
      // lands twice.
      await assertNoInflightGateway(locked.id, leg, tx);

      const money = await dealMoney(locked.id, tx);
      const receipt = vendorReceipt(money);
      const payout = dealerPayout(money);

      // SERVER-DERIVED, from the locks. Never the statement's figure.
      const amount = leg === "DEALER" ? payout : receipt;
      if (amount === null || amount <= 0) {
        throw new ValidationError(
          "This deal has no agreed vendor price, so the receipt amount cannot be derived.",
        );
      }

      if (paise(Math.abs(rowAmount)) !== paise(amount)) {
        throw new ValidationError(
          `This row is ${inr(Math.abs(rowAmount))}, but ${deal.request_no}'s ${
            leg === "DEALER" ? "dealer payout" : "vendor receipt"
          } is ${inr(amount)}. A bank row that does not match what we owe is not a settlement — find out what it is.`,
          { code: "AMOUNT_MISMATCH", row_amount: Math.abs(rowAmount), expected: amount },
        );
      }

      const subId = legSubId(deal.request_no, leg);

      const existing = await settlementsForDeal(locked.id, tx);
      if (existing.some((s) => s.leg_sub_id === subId)) {
        throw new ValidationError(
          `${subId} is already recorded. A settlement cannot be recorded twice — that is how a dealer gets paid twice.`,
        );
      }

      const [settlement] = await tx
        .insert(settlementTransactions)
        .values({
          deal_id: locked.id,
          group_txn_id: groupTxnId(deal.request_no),
          leg_sub_id: subId,
          leg,
          direction: leg === "DEALER" ? "OUT" : "IN",
          method: "STATEMENT",
          txn_ref: row.txn_ref,
          amount: amount.toString(),
          txn_date: row.txn_date,
          // No proof file, on purpose. The statement IS the proof; the row below
          // is what makes that traceable.
          proof_s3: null,
          statement_row_id: row.id,
          note: body.note ?? null,
          recorded_by: actor.id,
          closed_at: new Date(),
        })
        .returning({ id: settlementTransactions.id });

      if (!settlement) throw new ValidationError("The settlement could not be recorded.");

      await tx.execute(sql`
        UPDATE bank_statement_rows
           SET status = 'MATCHED',
               suggested_deal_id = ${locked.id}::uuid,
               suggested_leg = ${leg}::buyback_leg,
               matched_settlement_id = ${settlement.id}::uuid,
               matched_by = ${actor.id}::uuid,
               matched_at = now()
         WHERE id = ${row.id}::uuid
      `);

      // Recomputed rather than incremented: rows of an old import can be matched
      // at any time, and a counter that only ever goes up drifts the first time
      // one is corrected.
      await tx.execute(sql`
        UPDATE bank_statement_imports
           SET matched_count = (
                 SELECT count(*) FROM bank_statement_rows r
                 WHERE r.import_id = ${row.import_id}::uuid AND r.status = 'MATCHED'
               )
         WHERE id = ${row.import_id}::uuid
      `);

      const after = await settlementsForDeal(locked.id, tx);
      const closed = new Set(after.filter((s) => s.closed_at).map((s) => s.leg));
      const bothClosed = closed.has("DEALER") && closed.has("VENDOR");

      // The party who was actually paid is the one told. A dealer must never be
      // notified that a VENDOR paid us — and must never see the vendor's figure.
      const target =
        leg === "DEALER"
          ? {
              party: "DEALER" as const,
              channel: "WHATSAPP" as const,
              payload: {
                request_no: deal.request_no,
                amount,
                txn_ref: row.txn_ref,
                kind: "dealer_paid",
              },
            }
          : {
              party: "ADMIN" as const,
              channel: "PORTAL" as const,
              payload: { request_no: deal.request_no, amount, kind: "vendor_receipt" },
            };

      const first = await applyTransition({
        tx,
        dealId: locked.id,
        requestId: deal.request_id,
        currentStatus: locked.status,
        offerVersion: locked.offer_version,
        action: "record_settlement",
        actor: { id: actor.id, role: "admin" },
        after: {
          leg,
          leg_sub_id: subId,
          amount,
          method: "STATEMENT",
          statement_row_id: row.id,
        },
        fanOut: [{ ...target, discriminator: subId }],
      });

      if (!bothClosed) {
        return {
          status: first.to,
          settled: false,
          amount,
          sub_id: subId,
          request_no: deal.request_no,
        };
      }

      // The pair is complete. A SECOND transition, in the same transaction —
      // recording the money and settling the deal are two distinct facts, and the
      // audit log should say both happened.
      const settled = await applyTransition({
        tx,
        dealId: locked.id,
        requestId: deal.request_id,
        currentStatus: "INVOICE_APPROVED",
        offerVersion: locked.offer_version,
        action: "settle",
        actor: { id: actor.id, role: "admin" },
        after: {
          group_txn_id: groupTxnId(deal.request_no),
          paid_out: payout,
          received: receipt,
          realised_margin: (receipt ?? 0) - payout,
        },
        notificationPayload: {
          request_no: deal.request_no,
          realised_margin: (receipt ?? 0) - payout,
        },
      });

      return {
        status: settled.to,
        settled: true,
        amount,
        sub_id: subId,
        request_no: deal.request_no,
      };
    });

    return successResponse({
      row_id: rowId,
      request_no: outcome.request_no,
      status: outcome.status,
      leg_sub_id: outcome.sub_id,
      amount: outcome.amount,
      amount_label: inr(outcome.amount),
      both_legs_settled: outcome.settled,
    });
  },
);
