/**
 * The gateway domain core (E-193/R3) — the transactional heart every online
 * money path shares.
 *
 * settlement_transactions is a FACT: a row there means the money moved and the
 * leg is closed (recorded == closed). buyback_gateway_transactions is the
 * ATTEMPT — an in-flight RazorpayX payout or Razorpay Payment Link. Only a
 * terminal SUCCESS (PROCESSED for a payout, PAID for a link) is allowed to mint
 * a settlement, and it does so HERE, in `applyGatewayOutcome`, inside one
 * transaction that mirrors the manual settlement route's shape verbatim — so a
 * dealer paid by RazorpayX and a dealer paid by hand are indistinguishable to
 * everything downstream (the ledger, the notifications, the SETTLED transition).
 *
 * THE MONEY IS NEVER TAKEN FROM THE PROVIDER'S WORD. The row's amount was
 * server-derived from the locks at initiation; on success we re-derive it AGAIN
 * from the locks and refuse to settle if either the provider's figure or the
 * current locked figure disagrees. A payout that paid the wrong number is not a
 * settlement — it is an anomaly a human has to look at.
 *
 * This module writes buyback_deals.status ONLY through applyTransition (the one
 * writer, see transition.ts). Everything else here is the gateway row, the
 * settlement row, the audit row, and the admin portal alerts.
 *
 * No initiation routes, no webhooks, no ticker live here — but
 * `sweepInflightGatewayTxns` (the poller's unit of work) does, so a later task
 * only wires it to a tick.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buybackNotificationEvents, settlementTransactions } from "@/lib/db/schema";
import {
  buybackLinksConfigured,
  fetchBuybackPaymentLink,
} from "@/lib/razorpay";
import {
  fetchPayout,
  findPayoutByReference,
  payoutsConfigured,
} from "@/lib/razorpayx";
import { ValidationError } from "./errors";
import {
  dealMoney,
  dealerPayout,
  groupTxnId,
  legSubId,
  settlementsForDeal,
  vendorReceipt,
} from "./money";
import { applyTransition, loadDealForUpdate, recordActivity } from "./transition";
import type { BuybackTx } from "./tx";

/**
 * The statuses that count as "still in flight" — the money has not yet reached a
 * terminal outcome. These are exactly the values the DB's
 * gateway_txn_one_inflight_per_leg and gateway_txn_inflight_idx partial indexes
 * filter on; the two must stay in lockstep.
 */
export const INFLIGHT_STATUSES = ["INITIATED", "PENDING", "QUEUED", "PROCESSING"] as const;

/** Terminal — no further provider polling; only REVERSED can follow PROCESSED. */
const TERMINAL_STATUSES = new Set([
  "PROCESSED",
  "PAID",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "REVERSED",
]);

export interface GatewayRow {
  id: string;
  deal_id: string;
  leg: "DEALER" | "VENDOR";
  direction: "OUT" | "IN";
  kind: "PAYOUT" | "PAYMENT_LINK";
  provider: string;
  amount: string;
  status: string;
  provider_ref: string | null;
  payment_id: string | null;
  utr: string | null;
  short_url: string | null;
  failure_reason: string | null;
  settlement_id: string | null;
  initiated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const GATEWAY_COLUMNS = sql`
  id, deal_id, leg, direction, kind, provider, amount, status,
  provider_ref, payment_id, utr, short_url, failure_reason, settlement_id,
  initiated_by, created_at, updated_at
`;

/** Every gateway attempt on a deal, newest first. */
export async function gatewayTxnsForDeal(dealId: string): Promise<GatewayRow[]> {
  const rows = await db.execute(sql`
    SELECT ${GATEWAY_COLUMNS}
    FROM buyback_gateway_transactions
    WHERE deal_id = ${dealId}::uuid
    ORDER BY created_at DESC
  `);
  return rows as unknown as GatewayRow[];
}

/**
 * Refuse a manual/statement settlement while an online attempt for the same
 * (deal, leg) is still in flight (M13 race guard).
 *
 * The point is a specific class of double-payment: an admin clicks "Pay via
 * RazorpayX", the payout is queued, and — impatient — the admin then records the
 * same leg by hand. The payout later lands and mints a second settlement (or the
 * DB's leg_sub_id unique index refuses it, but only after the money has left the
 * building). This blocks the manual leg BEFORE that can happen.
 *
 * It runs inside the settlement route's own transaction (after its deal-row
 * lock), so its read is consistent with the transition about to be written. A
 * ValidationError, matching the settlements route's idiom for a refused write.
 */
export async function assertNoInflightGateway(
  dealId: string,
  leg: "DEALER" | "VENDOR",
  tx: BuybackTx,
): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT kind, status
    FROM buyback_gateway_transactions
    WHERE deal_id = ${dealId}::uuid
      AND leg = ${leg}::buyback_leg
      AND status IN ('INITIATED', 'PENDING', 'QUEUED', 'PROCESSING')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = (rows as unknown as Array<{ kind: string; status: string }>)[0];
  if (!row) return;

  if (row.kind === "PAYOUT") {
    throw new ValidationError(
      `A RazorpayX payout for this leg is in flight (${row.status}). It cannot be ` +
        `cancelled once sent to the bank — wait for it to land or fail before ` +
        `recording manually.`,
      { code: "GATEWAY_INFLIGHT", kind: row.kind, status: row.status },
    );
  }
  throw new ValidationError(
    `A payment link for this leg is active (${row.status}). Cancel the payment link first.`,
    { code: "GATEWAY_INFLIGHT", kind: row.kind, status: row.status },
  );
}

/**
 * The normalised, provider-agnostic outcome of reading a gateway attempt's
 * current state — from a poller fetch or (later) a webhook. `applyGatewayOutcome`
 * is the only thing that acts on it.
 */
export type GatewayOutcome =
  | { type: "progress"; status: "PENDING" | "QUEUED" | "PROCESSING"; raw: unknown }
  | {
      type: "success";
      utr?: string | null;
      paymentId?: string | null;
      providerAmountPaise: number;
      raw: unknown;
    }
  | {
      type: "failure";
      status: "FAILED" | "REJECTED" | "CANCELLED" | "EXPIRED";
      reason: string | null;
      raw: unknown;
    }
  | { type: "reversed"; reason: string | null; raw: unknown };

/** in-flight ordering: INITIATED < PENDING ≈ QUEUED < PROCESSING. */
const INFLIGHT_RANK: Record<string, number> = {
  INITIATED: 0,
  PENDING: 1,
  QUEUED: 1,
  PROCESSING: 2,
};

/** null → SQL NULL; anything else → its JSON text for a `::jsonb` cast. */
const toJsonb = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/**
 * Today's calendar date in IST (Asia/Kolkata — a fixed +5:30 with no DST), as
 * 'YYYY-MM-DD'. A bare `new Date().toISOString().slice(0,10)` stamps the UTC
 * date, which is YESTERDAY between 00:00 and 05:29 IST — a settlement minted just
 * after midnight in India would carry the previous day. Adding the fixed offset
 * before taking the UTC calendar date yields the IST calendar date.
 */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * An ADMIN-facing PORTAL alert that is NOT the product of a state transition —
 * an anomaly nobody planned for (a reversed payout, a payment on a dead link, an
 * amount that does not reconcile). Mirrors applyTransition's insert into
 * buyback_notification_events, but direct: these carry no `from`/`to` because no
 * status moved (or none should have). idempotency_key is UNIQUE, so a re-run of
 * the same sweep/webhook cannot double-alert — ON CONFLICT DO NOTHING.
 */
async function insertAdminPortalAlert(
  tx: BuybackTx,
  args: {
    dealId: string;
    requestId: string;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .insert(buybackNotificationEvents)
    .values({
      deal_id: args.dealId,
      request_id: args.requestId,
      event_type: args.eventType,
      recipient_party: "ADMIN",
      channel: "PORTAL",
      recipient_ref: null,
      idempotency_key: args.idempotencyKey,
      payload: args.payload as never,
    })
    .onConflictDoNothing();
}

export interface ApplyGatewayResult {
  applied: boolean;
  dealStatus?: string;
  note?: string;
}

/**
 * Act on one gateway outcome, in ONE transaction, against ONE gateway row.
 *
 * Lock ordering is always gateway row → deal row, so this can never deadlock
 * against a settlement route that locks the deal first and then reads the
 * gateway table (assertNoInflightGateway). Idempotent by construction: a row
 * already terminal is left alone, and the settlement's leg_sub_id unique index
 * is the last line of defence against a double-mint.
 */
export async function applyGatewayOutcome(
  gatewayTxnId: string,
  outcome: GatewayOutcome,
): Promise<ApplyGatewayResult> {
  return db.transaction(async (tx): Promise<ApplyGatewayResult> => {
    // 1. Lock the attempt row. Everything below reads from this snapshot.
    const rows = await tx.execute(sql`
      SELECT ${GATEWAY_COLUMNS}
      FROM buyback_gateway_transactions
      WHERE id = ${gatewayTxnId}::uuid
      FOR UPDATE
    `);
    const row = (rows as unknown as GatewayRow[])[0];
    if (!row) return { applied: false, note: "unknown gateway txn" };

    // The deal + request the attempt belongs to. Lazy: the hot path (progress)
    // never needs it, so it is only fetched on the branches that write an audit
    // row, a notification, or a settlement.
    let dealRefCache: { request_id: string; request_no: string } | null | undefined;
    const getDealRef = async (): Promise<{ request_id: string; request_no: string }> => {
      if (dealRefCache === undefined) {
        const r = (await tx.execute(sql`
          SELECT br.id AS request_id, br.request_no
          FROM buyback_deals bd
          JOIN buyback_requests br ON br.id = bd.request_id
          WHERE bd.id = ${row.deal_id}::uuid
        `)) as unknown as Array<{ request_id: string; request_no: string }>;
        dealRefCache = r[0] ?? null;
      }
      if (!dealRefCache) {
        throw new Error(
          `gateway txn ${gatewayTxnId} references deal ${row.deal_id}, which has no request`,
        );
      }
      return dealRefCache;
    };

    // A provider figure that does not equal what we owe (in paise) is not a
    // payment we can record. Mark the attempt FAILED, alert, mint NOTHING.
    const markAmountMismatch = async (
      providerPaise: number,
      expectedPaise: number,
      raw: unknown,
    ): Promise<ApplyGatewayResult> => {
      const reason = `AMOUNT_MISMATCH provider=${providerPaise} expected=${expectedPaise}`;
      await tx.execute(sql`
        UPDATE buyback_gateway_transactions
           SET status = 'FAILED',
               failure_reason = ${reason},
               raw_payload = ${toJsonb(raw)}::jsonb,
               updated_at = now()
         WHERE id = ${row.id}::uuid
      `);
      const ref = await getDealRef();
      await recordActivity({
        tx,
        requestId: ref.request_id,
        dealId: row.deal_id,
        actor: { id: row.initiated_by, role: "admin" },
        action: "gateway_amount_mismatch",
        after: { gateway_txn_id: row.id, reason },
      });
      await insertAdminPortalAlert(tx, {
        dealId: row.deal_id,
        requestId: ref.request_id,
        eventType: "gateway_amount_mismatch",
        idempotencyKey: `${row.deal_id}:gateway_amount_mismatch:${gatewayTxnId}`,
        payload: {
          kind: "gateway_alert",
          severity: "critical",
          message:
            `Gateway ${row.kind} on deal ${ref.request_no} reported ${providerPaise} paise ` +
            `but we expected ${expectedPaise} paise — marked FAILED, NO settlement recorded. Investigate.`,
          gateway_txn_id: row.id,
          request_no: ref.request_no,
          provider_paise: providerPaise,
          expected_paise: expectedPaise,
        },
      });
      return { applied: true, note: "amount mismatch" };
    };

    // 2. Terminal guard. A row that has already reached an end state is left
    //    alone — with two exceptions the world actually produces.
    if (TERMINAL_STATUSES.has(row.status)) {
      if (outcome.type === "success" && (row.status === "CANCELLED" || row.status === "EXPIRED")) {
        // The money moved on a link we had given up on. PROCEED to record it
        // (fall through to the success handler), but flag it: a payment on a
        // dead link is either a late genuine payment or someone paying the
        // wrong link — a human must confirm which.
        const ref = await getDealRef();
        await insertAdminPortalAlert(tx, {
          dealId: row.deal_id,
          requestId: ref.request_id,
          eventType: "gateway_deadlink_paid",
          idempotencyKey: `${row.deal_id}:gateway_deadlink_paid:${gatewayTxnId}`,
          payload: {
            kind: "gateway_alert",
            severity: "warning",
            message:
              `A payment arrived on a ${row.status.toLowerCase()} ${
                row.kind === "PAYOUT" ? "payout" : "payment link"
              } for deal ${ref.request_no} — recording it, but verify it is ` +
              `genuinely this deal's money.`,
            gateway_txn_id: row.id,
            request_no: ref.request_no,
          },
        });
        // deliberate fall-through: the success handler at the bottom runs.
      } else if (outcome.type === "reversed" && row.status === "PROCESSED") {
        // The bank bounced a payout AFTER it processed. There is a real
        // settlement and a SETTLED (or CLOSED) deal behind this — neither is
        // auto-unwound. Flip the attempt to REVERSED and hand it to a human.
        await tx.execute(sql`
          UPDATE buyback_gateway_transactions
             SET status = 'REVERSED',
                 failure_reason = ${outcome.reason ?? "payout reversed by bank after processing"},
                 raw_payload = ${toJsonb(outcome.raw)}::jsonb,
                 updated_at = now()
           WHERE id = ${row.id}::uuid
        `);
        const ref = await getDealRef();
        await recordActivity({
          tx,
          requestId: ref.request_id,
          dealId: row.deal_id,
          actor: { id: row.initiated_by, role: "admin" },
          action: "gateway_payout_reversed",
          after: { gateway_txn_id: row.id, settlement_id: row.settlement_id, reason: outcome.reason },
        });
        await insertAdminPortalAlert(tx, {
          dealId: row.deal_id,
          requestId: ref.request_id,
          eventType: "gateway_reversed",
          idempotencyKey: `${row.deal_id}:gateway_reversed:${gatewayTxnId}`,
          payload: {
            kind: "gateway_alert",
            severity: "critical",
            message:
              `Payout on deal ${ref.request_no} was REVERSED by the bank AFTER processing — ` +
              `the settlement and deal status are left untouched; manual intervention required.`,
            gateway_txn_id: row.id,
            request_no: ref.request_no,
            settlement_id: row.settlement_id,
          },
        });
        return { applied: true };
      } else {
        return { applied: false, note: "already terminal" };
      }
    }

    // 3. Progress. Move only forward through the in-flight ladder — a QUEUED
    //    event arriving after we already saw PROCESSING must NOT downgrade the
    //    row. raw_payload and updated_at always advance, so the poller's
    //    ">10 min stale" clock resets on every genuine check-in.
    if (outcome.type === "progress") {
      const current = INFLIGHT_RANK[row.status] ?? -1;
      const next = INFLIGHT_RANK[outcome.status] ?? -1;
      const nextStatus = next > current ? outcome.status : row.status;
      await tx.execute(sql`
        UPDATE buyback_gateway_transactions
           SET status = ${nextStatus}::buyback_gateway_status,
               raw_payload = ${toJsonb(outcome.raw)}::jsonb,
               updated_at = now()
         WHERE id = ${row.id}::uuid
      `);
      return { applied: true };
    }

    // 4. Failure. Terminal, but leaves NO settlement — a retry is a brand new
    //    gateway row, never an update of this one.
    if (outcome.type === "failure") {
      await tx.execute(sql`
        UPDATE buyback_gateway_transactions
           SET status = ${outcome.status}::buyback_gateway_status,
               failure_reason = ${outcome.reason},
               raw_payload = ${toJsonb(outcome.raw)}::jsonb,
               updated_at = now()
         WHERE id = ${row.id}::uuid
      `);
      const ref = await getDealRef();
      const action =
        row.kind === "PAYOUT"
          ? "gateway_payout_failed"
          : outcome.status === "CANCELLED"
            ? "gateway_link_cancelled"
            : outcome.status === "EXPIRED"
              ? "gateway_link_expired"
              : "gateway_link_failed";
      await recordActivity({
        tx,
        requestId: ref.request_id,
        dealId: row.deal_id,
        actor: { id: row.initiated_by, role: "admin" },
        action,
        after: { gateway_txn_id: row.id, status: outcome.status, reason: outcome.reason },
      });
      await insertAdminPortalAlert(tx, {
        dealId: row.deal_id,
        requestId: ref.request_id,
        eventType: "gateway_failed",
        idempotencyKey: `${row.deal_id}:gateway_failed:${gatewayTxnId}`,
        payload: {
          kind: "gateway_alert",
          message:
            `Gateway ${row.kind} on deal ${ref.request_no} ${outcome.status.toLowerCase()}` +
            `${outcome.reason ? ` — ${outcome.reason}` : ""}. No settlement recorded; retry is a new attempt.`,
          gateway_txn_id: row.id,
          request_no: ref.request_no,
          status: outcome.status,
        },
      });
      return { applied: true };
    }

    // 4b. A `reversed` outcome on a row that never PROCESSED through us (handled
    //     the PROCESSED case above). Not the brief's happy path, but a provider
    //     that jumps straight to reversed must not fall into the success handler.
    //     There is no settlement to unwind — mark terminal and alert.
    if (outcome.type === "reversed") {
      await tx.execute(sql`
        UPDATE buyback_gateway_transactions
           SET status = 'REVERSED',
               failure_reason = ${outcome.reason ?? "payout reversed by bank"},
               raw_payload = ${toJsonb(outcome.raw)}::jsonb,
               updated_at = now()
         WHERE id = ${row.id}::uuid
      `);
      const ref = await getDealRef();
      await recordActivity({
        tx,
        requestId: ref.request_id,
        dealId: row.deal_id,
        actor: { id: row.initiated_by, role: "admin" },
        action: "gateway_payout_reversed",
        after: { gateway_txn_id: row.id, reason: outcome.reason, note: "reversed before a settlement was minted" },
      });
      await insertAdminPortalAlert(tx, {
        dealId: row.deal_id,
        requestId: ref.request_id,
        eventType: "gateway_reversed",
        idempotencyKey: `${row.deal_id}:gateway_reversed:${gatewayTxnId}`,
        payload: {
          kind: "gateway_alert",
          severity: "critical",
          message:
            `Payout on deal ${ref.request_no} was reversed before it settled through iTarang — ` +
            `no settlement was recorded; investigate.`,
          gateway_txn_id: row.id,
          request_no: ref.request_no,
        },
      });
      return { applied: true };
    }

    // 5. Success. `outcome` is narrowed to the success variant here.

    // 5a. Provider figure vs the row's own server-derived amount, in paise.
    const rowPaise = Math.round(Number(row.amount) * 100);
    if (outcome.providerAmountPaise !== rowPaise) {
      return markAmountMismatch(outcome.providerAmountPaise, rowPaise, outcome.raw);
    }

    // 5b. Lock the deal row (ordering: gateway row → deal row).
    const ref = await getDealRef();
    const locked = await loadDealForUpdate(tx, ref.request_id);
    if (!locked) {
      throw new Error(`gateway txn ${gatewayTxnId}: deal for request ${ref.request_id} vanished`);
    }

    const subId = legSubId(ref.request_no, row.leg);
    const alreadySettled = (await settlementsForDeal(locked.id, tx)).some(
      (s) => s.leg_sub_id === subId,
    );
    const terminalSuccess = row.kind === "PAYOUT" ? "PROCESSED" : "PAID";

    // 5c. The money moved, but the deal is no longer expecting it — it advanced
    //     past INVOICE_APPROVED, or this leg is already settled. Record the
    //     gateway success as terminal (so it stops being polled) WITHOUT a
    //     settlement and with settlement_id NULL, and shout: probable double pay.
    if (locked.status !== "INVOICE_APPROVED" || alreadySettled) {
      await tx.execute(sql`
        UPDATE buyback_gateway_transactions
           SET status = ${terminalSuccess}::buyback_gateway_status,
               utr = ${outcome.utr ?? null},
               payment_id = ${outcome.paymentId ?? null},
               raw_payload = ${toJsonb(outcome.raw)}::jsonb,
               updated_at = now()
         WHERE id = ${row.id}::uuid
      `);
      await recordActivity({
        tx,
        requestId: ref.request_id,
        dealId: locked.id,
        actor: { id: row.initiated_by, role: "admin" },
        action: "gateway_settlement_skipped",
        after: {
          gateway_txn_id: row.id,
          leg: row.leg,
          reason: alreadySettled ? "leg already settled" : `deal is ${locked.status}`,
        },
      });
      await insertAdminPortalAlert(tx, {
        dealId: locked.id,
        requestId: ref.request_id,
        eventType: "gateway_double_payment",
        idempotencyKey: `${row.deal_id}:gateway_double_pay:${gatewayTxnId}`,
        payload: {
          kind: "gateway_alert",
          severity: "critical",
          message:
            `Gateway ${row.kind} succeeded but the ${row.leg} leg is already settled or the deal ` +
            `moved on — possible double payment, investigate deal ${ref.request_no}.`,
          gateway_txn_id: row.id,
          request_no: ref.request_no,
          leg: row.leg,
        },
      });
      return { applied: true, note: "anomaly: already settled" };
    }

    // 5d. Re-derive from the locks. The row's amount was derived at initiation;
    //     if a re-lock changed the price since, the gateway paid the OLD figure,
    //     which is now a mismatch and must not mint a settlement.
    const money = await dealMoney(locked.id, tx);
    const payout = dealerPayout(money);
    const receipt = vendorReceipt(money);
    const expected = row.leg === "DEALER" ? payout : receipt;
    if (expected === null || expected <= 0) {
      return markAmountMismatch(outcome.providerAmountPaise, 0, outcome.raw);
    }
    const expectedPaise = Math.round(expected * 100);
    if (outcome.providerAmountPaise !== expectedPaise) {
      return markAmountMismatch(outcome.providerAmountPaise, expectedPaise, outcome.raw);
    }

    // 5e. Mint the settlement — method='API', the ONE fact a terminal gateway
    //     success is allowed to create. Same shape as the manual route's insert.
    const txnRef = outcome.utr ?? outcome.paymentId ?? row.provider_ref;
    const [settlement] = await tx
      .insert(settlementTransactions)
      .values({
        deal_id: locked.id,
        group_txn_id: groupTxnId(ref.request_no),
        leg_sub_id: subId,
        leg: row.leg,
        direction: row.leg === "DEALER" ? "OUT" : "IN",
        method: "API",
        txn_ref: txnRef,
        amount: expected.toString(),
        // Recorded = closed, exactly like the manual route: the amount is derived
        // from the locks, so it is paid in full or not recorded at all. The date
        // is the IST calendar date (istToday) — a UTC slice would stamp yesterday
        // for a payout that processed between 00:00 and 05:29 IST.
        txn_date: istToday(),
        proof_s3: null,
        note: `via ${row.provider} ${row.kind} ${row.provider_ref ?? ""}`.trim(),
        recorded_by: row.initiated_by,
        closed_at: new Date(),
      })
      .returning({ id: settlementTransactions.id });
    if (!settlement) throw new Error("gateway settlement insert returned no row");

    // 5f. Point the gateway row at the settlement it minted.
    await tx.execute(sql`
      UPDATE buyback_gateway_transactions
         SET status = ${terminalSuccess}::buyback_gateway_status,
             utr = ${outcome.utr ?? null},
             payment_id = ${outcome.paymentId ?? null},
             raw_payload = ${toJsonb(outcome.raw)}::jsonb,
             settlement_id = ${settlement.id}::uuid,
             updated_at = now()
       WHERE id = ${row.id}::uuid
    `);

    // 5g. record_settlement — the SAME fan-out the manual route uses for this
    //     leg, verbatim, so a gateway payout and a manual one notify identically.
    //     The party who was actually paid is the one told; a dealer must never be
    //     notified that a VENDOR paid us, nor see the vendor's figure.
    const fanOutTarget =
      row.leg === "DEALER"
        ? {
            party: "DEALER" as const,
            channel: "WHATSAPP" as const,
            payload: {
              request_no: ref.request_no,
              amount: expected,
              txn_ref: txnRef,
              kind: "dealer_paid",
            },
          }
        : {
            party: "ADMIN" as const,
            channel: "PORTAL" as const,
            payload: { request_no: ref.request_no, amount: expected, kind: "vendor_receipt" },
          };

    const first = await applyTransition({
      tx,
      dealId: locked.id,
      requestId: ref.request_id,
      currentStatus: locked.status,
      offerVersion: locked.offer_version,
      action: "record_settlement",
      actor: { id: row.initiated_by, role: "admin" },
      after: { leg: row.leg, leg_sub_id: subId, amount: expected, method: "API" },
      fanOut: [{ ...fanOutTarget, discriminator: subId }],
    });

    const after = await settlementsForDeal(locked.id, tx);
    const closed = new Set(after.filter((s) => s.closed_at).map((s) => s.leg));
    const bothClosed = closed.has("DEALER") && closed.has("VENDOR");
    if (!bothClosed) {
      return { applied: true, dealStatus: first.to };
    }

    // The pair is complete. A SECOND transition, same transaction — recording the
    // money and settling the deal are two distinct facts (verbatim from the
    // manual route's second-transition block).
    const settled = await applyTransition({
      tx,
      dealId: locked.id,
      requestId: ref.request_id,
      currentStatus: "INVOICE_APPROVED",
      offerVersion: locked.offer_version,
      action: "settle",
      actor: { id: row.initiated_by, role: "admin" },
      after: {
        group_txn_id: groupTxnId(ref.request_no),
        paid_out: payout,
        received: receipt,
        realised_margin: (receipt ?? 0) - payout,
      },
      notificationPayload: {
        request_no: ref.request_no,
        realised_margin: (receipt ?? 0) - payout,
      },
    });

    return { applied: true, dealStatus: settled.to };
  });
}

/**
 * Map a RazorpayX payout status onto a GatewayOutcome. Shared with the webhook
 * task (which reuses it on the payout entity a signed event carries) — null for
 * a status we do not recognise, so an unknown value is skipped, never guessed.
 */
export function mapPayoutStatus(
  status: string,
  entity: {
    utr?: string | null;
    amountPaise?: number | null;
    failureReason?: string | null;
    raw?: unknown;
  },
): GatewayOutcome | null {
  const raw = entity.raw ?? entity;
  switch (status) {
    case "queued":
      return { type: "progress", status: "QUEUED", raw };
    case "pending":
      return { type: "progress", status: "PENDING", raw };
    case "processing":
      return { type: "progress", status: "PROCESSING", raw };
    case "processed":
      return {
        type: "success",
        utr: entity.utr ?? null,
        providerAmountPaise: entity.amountPaise ?? 0,
        raw,
      };
    case "failed":
      return { type: "failure", status: "FAILED", reason: entity.failureReason ?? null, raw };
    case "rejected":
      return { type: "failure", status: "REJECTED", reason: entity.failureReason ?? null, raw };
    case "cancelled":
      return { type: "failure", status: "CANCELLED", reason: entity.failureReason ?? null, raw };
    case "reversed":
      return { type: "reversed", reason: entity.failureReason ?? null, raw };
    default:
      return null;
  }
}

/**
 * Map a Razorpay Payment Link status onto a GatewayOutcome. `created` is a link
 * still waiting to be paid — nothing to act on, so null (skip). Shared with the
 * webhook task, same as mapPayoutStatus.
 */
export function mapPaymentLinkStatus(
  status: string,
  entity: { paymentId?: string | null; amountPaidPaise?: number | null; raw?: unknown },
): GatewayOutcome | null {
  const raw = entity.raw ?? entity;
  switch (status) {
    case "paid":
      return {
        type: "success",
        paymentId: entity.paymentId ?? null,
        providerAmountPaise: entity.amountPaidPaise ?? 0,
        raw,
      };
    case "cancelled":
      return { type: "failure", status: "CANCELLED", reason: null, raw };
    case "expired":
      return { type: "failure", status: "EXPIRED", reason: null, raw };
    case "partially_paid":
      return { type: "progress", status: "PROCESSING", raw };
    case "created":
      return null; // still waiting for the vendor to pay — nothing to do yet
    default:
      return null;
  }
}

// ─────────────────── correlation + shaping helpers (R4–R6) ──────────────────
// Read/adopt/shape helpers the HTTP surface (initiation routes, webhooks, the
// refresh route) shares. All the raw gateway-row SQL — enum casts and the
// provider_ref race guards — lives HERE, in the domain module, not scattered
// across route files.

/** A single attempt by id, or null. */
export async function getGatewayTxn(id: string): Promise<GatewayRow | null> {
  const rows = await db.execute(sql`
    SELECT ${GATEWAY_COLUMNS}
    FROM buyback_gateway_transactions
    WHERE id = ${id}::uuid
  `);
  return (rows as unknown as GatewayRow[])[0] ?? null;
}

/** Correlate a webhook to its attempt by the provider's id (unique index). */
export async function findGatewayTxnByProviderRef(
  providerRef: string,
): Promise<GatewayRow | null> {
  const rows = await db.execute(sql`
    SELECT ${GATEWAY_COLUMNS}
    FROM buyback_gateway_transactions
    WHERE provider_ref = ${providerRef}
    LIMIT 1
  `);
  return (rows as unknown as GatewayRow[])[0] ?? null;
}

/**
 * Claim a provider_ref for an attempt that has none yet. Guarded by
 * `WHERE provider_ref IS NULL` AND the provider_ref unique index: if a concurrent
 * path (a webhook and the poller racing to adopt the same payout) already set it,
 * this updates 0 rows and returns false — the caller must NOT act on its stale
 * NULL-provider_ref snapshot; whoever won reconciles the fresh row on its pass.
 */
export async function adoptGatewayProviderRef(
  txnId: string,
  providerRef: string,
): Promise<boolean> {
  try {
    const rows = await db.execute(sql`
      UPDATE buyback_gateway_transactions
         SET provider_ref = ${providerRef}, updated_at = now()
       WHERE id = ${txnId}::uuid AND provider_ref IS NULL
      RETURNING id
    `);
    return (rows as unknown as unknown[]).length > 0;
  } catch {
    // provider_ref unique violation: another attempt already owns this id.
    return false;
  }
}

/**
 * Stamp the provider's identifiers onto a freshly-created attempt, immediately
 * after its create call returns. provider_ref is unique and set exactly once.
 * Guarded on status='INITIATED' so that if a webhook has already advanced the row
 * (the create response and the first webhook can race), this no-ops instead of
 * clobbering the status the webhook moved forward — that webhook's adopt path set
 * provider_ref itself.
 */
export async function attachProviderRef(
  txnId: string,
  opts: { providerRef: string; raw: unknown; shortUrl?: string | null; status?: "PENDING" },
): Promise<void> {
  const sets = [
    sql`provider_ref = ${opts.providerRef}`,
    sql`raw_payload = ${toJsonb(opts.raw)}::jsonb`,
    sql`updated_at = now()`,
  ];
  if (opts.shortUrl !== undefined) sets.push(sql`short_url = ${opts.shortUrl}`);
  if (opts.status) sets.push(sql`status = ${opts.status}::buyback_gateway_status`);
  await db.execute(sql`
    UPDATE buyback_gateway_transactions
       SET ${sql.join(sets, sql`, `)}
     WHERE id = ${txnId}::uuid AND status = 'INITIATED'
  `);
}

/** The request a deal hangs off — for a webhook/route's audit + alert copy. */
export async function dealRequestRef(
  dealId: string,
): Promise<{ request_id: string; request_no: string } | null> {
  const rows = (await db.execute(sql`
    SELECT br.id AS request_id, br.request_no
    FROM buyback_deals bd
    JOIN buyback_requests br ON br.id = bd.request_id
    WHERE bd.id = ${dealId}::uuid
  `)) as unknown as Array<{ request_id: string; request_no: string }>;
  return rows[0] ?? null;
}

/**
 * The redacted attempt projection the admin UI consumes — the SAME shape the
 * invoice GET's gateway.txns entries use. Never carries raw_payload, the internal
 * settlement id, initiated_by, provider_ref, or payment_id.
 */
export interface GatewayTxnView {
  id: string;
  leg: "DEALER" | "VENDOR";
  kind: "PAYOUT" | "PAYMENT_LINK";
  status: string;
  short_url: string | null;
  utr: string | null;
  failure_reason: string | null;
  created_at: Date | string;
}
export function gatewayTxnView(row: GatewayRow): GatewayTxnView {
  return {
    id: row.id,
    leg: row.leg,
    kind: row.kind,
    status: row.status,
    short_url: row.short_url,
    utr: row.utr,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
  };
}

// ─────────────────────────── the poller's row work ──────────────────────────

/** Whether a reconciled row moved (applied) and whether it reached terminality. */
export interface GatewaySweepRowResult {
  /** applyGatewayOutcome changed state (false on a no-op against a terminal row). */
  applied: boolean;
  /** the applied outcome moved the row to a terminal state (not a progress ping). */
  terminal: boolean;
}

/** Apply an outcome and classify it for the sweep/refresh summary. A `progress`
 *  outcome is an in-flight check-in, NOT an advance to a terminal state — the two
 *  are counted separately so the summary is not misleading. */
async function applyAndClassify(
  rowId: string,
  outcome: GatewayOutcome,
): Promise<GatewaySweepRowResult> {
  const result = await applyGatewayOutcome(rowId, outcome);
  return { applied: result.applied, terminal: outcome.type !== "progress" };
}

/** Reconcile ONE in-flight payout row against RazorpayX. */
async function sweepPayoutRow(row: GatewayRow): Promise<GatewaySweepRowResult | null> {
  // The attempt committed but we have no provider ref — the create call may have
  // succeeded without our storing the id (a crash between call and commit), or
  // it may never have happened.
  if (!row.provider_ref && row.status === "INITIATED") {
    const found = await findPayoutByReference(row.id);
    if (found) {
      // Adopt the ref. If a concurrent adopter (a racing webhook) already won,
      // the guarded UPDATE matches 0 rows → skip and let the winner reconcile the
      // fresh row, rather than acting on our stale NULL-provider_ref snapshot.
      const adopted = await adoptGatewayProviderRef(row.id, found.id);
      if (!adopted) return null;
      const outcome = mapPayoutStatus(found.status, found);
      return outcome ? applyAndClassify(row.id, outcome) : null;
    }
    // Never reached the provider. Give a create 30 minutes before declaring it
    // dead — one may still be in flight in another request.
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > 30 * 60 * 1000) {
      return applyAndClassify(row.id, {
        type: "failure",
        status: "FAILED",
        reason: "never reached provider",
        raw: null,
      });
    }
    return null;
  }

  if (!row.provider_ref) return null; // in-flight, no ref, not INITIATED — wait
  const payout = await fetchPayout(row.provider_ref);
  const outcome = mapPayoutStatus(payout.status, payout);
  return outcome ? applyAndClassify(row.id, outcome) : null;
}

/** Reconcile ONE in-flight payment-link row against Razorpay. */
async function sweepLinkRow(row: GatewayRow): Promise<GatewaySweepRowResult | null> {
  if (!row.provider_ref) return null;
  const link = await fetchBuybackPaymentLink(row.provider_ref);
  const raw = (link.raw ?? {}) as Record<string, unknown>;
  const amountPaidPaise = Number((raw.amount_paid as number | undefined) ?? 0);
  const paymentsArr =
    (link.payments as Array<Record<string, unknown>> | undefined) ??
    (raw.payments as Array<Record<string, unknown>> | undefined) ??
    [];
  const paid = paymentsArr.find((p) => p && (p.status === "captured" || p.payment_id));
  const paymentId = paid?.payment_id ? String(paid.payment_id) : null;
  const outcome = mapPaymentLinkStatus(link.status, { paymentId, amountPaidPaise, raw: link.raw });
  return outcome ? applyAndClassify(row.id, outcome) : null;
}

/**
 * Reconcile ONE attempt against its provider on demand (the refresh route) — the
 * same per-row work the poller does, minus the staleness filter. The caller owns
 * the provider-config gate and re-reads the row afterward for the response.
 */
export async function reconcileGatewayRow(
  row: GatewayRow,
): Promise<GatewaySweepRowResult | null> {
  return row.kind === "PAYOUT" ? sweepPayoutRow(row) : sweepLinkRow(row);
}

/**
 * The poller's unit of work (the ticker in instrumentation-node.ts drives it).
 *
 * Reads in-flight rows that have gone quiet for >10 minutes, oldest first, and
 * reconciles each against its provider. Every row is wrapped in try/catch: a
 * provider error on ONE row (a transient 5xx, a rate limit) must not abort the
 * sweep — the next row may be a different provider entirely.
 *
 * `advanced` counts only rows that reached a TERMINAL state; a mere in-flight
 * progress check-in is counted in `progressed`, so the summary never overstates
 * how many attempts actually resolved.
 */
export async function sweepInflightGatewayTxns(
  limit = 20,
): Promise<{ checked: number; advanced: number; progressed: number; failed: number }> {
  const rows = (await db.execute(sql`
    SELECT ${GATEWAY_COLUMNS}
    FROM buyback_gateway_transactions
    WHERE status IN ('INITIATED', 'PENDING', 'QUEUED', 'PROCESSING')
      AND updated_at < now() - interval '10 minutes'
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `)) as unknown as GatewayRow[];

  let checked = 0;
  let advanced = 0;
  let progressed = 0;
  let failed = 0;

  for (const row of rows) {
    checked += 1;
    try {
      // No provider configured on this env → cannot poll; leave the row for a
      // run where the keys are present rather than count a spurious failure.
      if (row.kind === "PAYOUT" && !payoutsConfigured()) continue;
      if (row.kind === "PAYMENT_LINK" && !buybackLinksConfigured()) continue;

      const result = await reconcileGatewayRow(row);
      if (result?.applied) {
        if (result.terminal) advanced += 1;
        else progressed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { checked, advanced, progressed, failed };
}
