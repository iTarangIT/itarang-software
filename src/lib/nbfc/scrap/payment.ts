/**
 * E-258 — paying for a scrap consignment, and taking delivery of the lot.
 *
 * WHICH RAZORPAY PRODUCT, AND WHY IT IS NOT CHECKOUT.
 *   The money moves iTarang → NBFC. Razorpay Checkout and Payment Links only
 *   COLLECT into the iTarang account; neither can send money out, so neither
 *   can settle this deal. Paying a counterparty is a RazorpayX payout, which
 *   the repo already has a client for (`src/lib/razorpayx.ts`, built for the
 *   buyback vendor leg). That is what this uses.
 *
 * THE OFFLINE ESCAPE HATCH.
 *   RazorpayX needs three env vars (`RAZORPAYX_KEY_ID`, `_KEY_SECRET`,
 *   `_ACCOUNT_NUMBER`) that are not set in every environment, and plenty of
 *   these settlements are, in practice, a NEFT someone did from the bank's own
 *   portal. So an offline record is a first-class path — explicit, attributed,
 *   reference-carrying, and stamping the same `paid_at` the gateway would, so
 *   downstream code has exactly one thing to check. Copied deliberately from
 *   `recordOfflinePayment()` in src/lib/nbfc/auction/purchases.ts, which exists
 *   for the same reason.
 *
 * WHY `processing` IS A STATE.
 *   A payout is queued/pending for seconds to hours. `payment_status =
 *   'processing'` means the money has been ORDERED but the terminal state has
 *   not been read back — the batteries do NOT transfer yet, and re-clicking Pay
 *   re-reads the payout rather than sending a second one. Only `processed`
 *   flips the deal to paid.
 *
 * IDEMPOTENCY.
 *   The consignment id is the payout's `reference_id` AND its
 *   `X-Payout-Idempotency` key, so a double-click, a retried request, or a
 *   crashed process between "sent" and "recorded" cannot pay twice — RazorpayX
 *   returns the original payout, and `refreshPayout()` can find it by reference
 *   even if the id was never persisted.
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  scrapConsignments,
  scrapConsignmentItems,
  recoveryBatteries,
} from "@/lib/db/schema";
import {
  getConsignment,
  auditScrapAction,
  type ConsignmentDetail,
} from "@/lib/nbfc/scrap/consignment";
import {
  getScrapPaymentTiming,
  type ScrapPaymentTiming,
} from "@/lib/nbfc/scrap/payment-settings";

export type ScrapPaymentProvider = "razorpayx" | "offline";

/** RazorpayX payout states that mean the money is gone for good. */
const TERMINAL_OK = new Set(["processed"]);
/** …and the ones that mean it is not coming back out. */
const TERMINAL_FAIL = new Set(["reversed", "cancelled", "rejected", "failed"]);

export interface PayResult {
  consignment: ConsignmentDetail;
  /** unpaid | processing | paid | failed — after this call. */
  payment_status: string;
  payout_id: string | null;
  utr: string | null;
  /** Set when the gateway is not configured and an offline record is needed. */
  gateway_unavailable?: boolean;
  message?: string;
}

/**
 * [E-259] The payment term gate.
 *
 * Async, and it reads the NBFC's term live rather than a copy frozen onto the
 * consignment: an admin who has just switched an NBFC to pay-after expects
 * that to bind the deal sitting open in the next tab, not only the ones
 * started afterwards.
 *
 * The check is here rather than in the route so both money paths — the
 * RazorpayX payout and the offline record — are covered by one rule. An
 * offline transfer that skipped the gate would be the obvious way around it.
 */
async function assertPayable(c: ConsignmentDetail): Promise<ScrapPaymentTiming> {
  if (c.payment_status === "paid" || c.status === "paid") {
    throw new Error("CONFLICT: this consignment has already been paid for");
  }
  if (c.status !== "agreed") {
    throw new Error(
      `CONFLICT: consignment is ${c.status} — payment is only made once a rate is agreed`,
    );
  }
  if (c.agreed_amount == null || c.agreed_amount <= 0) {
    throw new Error("CONFLICT: this consignment has no agreed amount");
  }

  const { timing } = await getScrapPaymentTiming(c.tenant_id);
  if (timing === "post_lot" && !c.received_at) {
    throw new Error(
      "CONFLICT: this NBFC is on pay-after-the-lot terms — mark the batteries received at iTarang before releasing the payment",
    );
  }
  return timing;
}

function assertPayee(c: ConsignmentDetail): {
  name: string;
  ifsc: string;
  accountNumber: string;
} {
  if (!c.payee_name || !c.payee_account_number || !c.payee_ifsc) {
    throw new Error(
      "CONFLICT: the NBFC has not filled in its payee bank details for this consignment",
    );
  }
  return {
    name: c.payee_name,
    ifsc: c.payee_ifsc,
    accountNumber: c.payee_account_number,
  };
}

/**
 * Sends the money via RazorpayX.
 *
 * Returns `gateway_unavailable` rather than throwing when the env vars are
 * unset: the deal is still valid and can be settled by bank transfer and
 * recorded offline, and saying so plainly is more useful than a 500.
 */
export async function payConsignment(input: {
  consignment_id: string;
  actor_user_id: string | null;
}): Promise<PayResult> {
  const c = await getConsignment(input.consignment_id, null);
  if (!c) throw new Error("NOT_FOUND: consignment not found");
  await assertPayable(c);

  // Already ordered and still in flight — read it back instead of sending a
  // second payout.
  if (c.payment_status === "processing" && c.payment_ref) {
    return refreshPayout({
      consignment_id: c.id,
      actor_user_id: input.actor_user_id,
    });
  }

  const { payoutsConfigured } = await import("@/lib/razorpayx");
  if (!payoutsConfigured()) {
    return {
      consignment: c,
      payment_status: c.payment_status,
      payout_id: null,
      utr: null,
      gateway_unavailable: true,
      message:
        "RazorpayX is not configured in this environment — pay by bank transfer and record it here with the reference.",
    };
  }

  const payee = assertPayee(c);
  const amountPaise = Math.round((c.agreed_amount ?? 0) * 100);
  if (amountPaise < 100) {
    throw new Error("CONFLICT: the agreed amount is below the ₹1 payout floor");
  }

  const now = new Date();
  // Mark it in flight BEFORE calling the provider. If the process dies mid-call
  // the row says 'processing' with no ref, and `refreshPayout()` finds the
  // payout by reference_id — whereas a row still saying 'unpaid' would invite
  // a second payout for the same deal.
  await db
    .update(scrapConsignments)
    .set({
      payment_status: "processing",
      payment_provider: "razorpayx",
      payment_failure_reason: null,
      updated_at: now,
    })
    .where(eq(scrapConsignments.id, c.id));

  const { createCompositePayout, razorpayxErrorMessage } = await import(
    "@/lib/razorpayx"
  );

  let payout;
  try {
    payout = await createCompositePayout({
      amountPaise,
      beneficiary: payee,
      contact: { name: c.tenant_name ?? payee.name },
      referenceId: c.id,
      narration: "iTarang scrap",
      notes: {
        itarang_scrap_consignment: c.ref_code,
        itarang_tenant_id: c.tenant_id,
        itarang_battery_count: String(c.battery_count),
      },
      idempotencyKey: c.id,
    });
  } catch (e) {
    const reason = razorpayxErrorMessage(e);
    await db
      .update(scrapConsignments)
      .set({
        payment_status: "failed",
        payment_failure_reason: reason,
        updated_at: new Date(),
      })
      .where(eq(scrapConsignments.id, c.id));
    throw new Error(`PROVIDER_ERROR: ${reason}`);
  }

  return applyPayoutState({
    consignment_id: c.id,
    actor_user_id: input.actor_user_id,
    payout,
  });
}

/**
 * Re-reads a payout that was left in flight and applies whatever it says now.
 *
 * Falls back to a lookup by `reference_id` when the payout id was never stored
 * — the crashed-between-send-and-record case.
 */
export async function refreshPayout(input: {
  consignment_id: string;
  actor_user_id: string | null;
}): Promise<PayResult> {
  const c = await getConsignment(input.consignment_id, null);
  if (!c) throw new Error("NOT_FOUND: consignment not found");
  if (c.payment_status === "paid") {
    return {
      consignment: c,
      payment_status: "paid",
      payout_id: c.payment_ref,
      utr: c.payment_utr,
    };
  }

  const { payoutsConfigured, fetchPayout, findPayoutByReference } = await import(
    "@/lib/razorpayx"
  );
  if (!payoutsConfigured()) {
    return {
      consignment: c,
      payment_status: c.payment_status,
      payout_id: c.payment_ref,
      utr: c.payment_utr,
      gateway_unavailable: true,
    };
  }

  const payout = c.payment_ref?.startsWith("pout_")
    ? await fetchPayout(c.payment_ref)
    : await findPayoutByReference(c.id);

  if (!payout) {
    // Ordered, but the provider has no record of it — back to unpaid so the
    // deal is payable again rather than stuck in 'processing' forever.
    await db
      .update(scrapConsignments)
      .set({ payment_status: "unpaid", updated_at: new Date() })
      .where(eq(scrapConsignments.id, c.id));
    return {
      consignment: (await getConsignment(c.id, null))!,
      payment_status: "unpaid",
      payout_id: null,
      utr: null,
      message: "No payout was found for this consignment — it can be paid again.",
    };
  }

  return applyPayoutState({
    consignment_id: c.id,
    actor_user_id: input.actor_user_id,
    payout,
  });
}

async function applyPayoutState(input: {
  consignment_id: string;
  actor_user_id: string | null;
  payout: { id: string; status: string; utr: string | null; failureReason: string | null };
}): Promise<PayResult> {
  const { payout } = input;
  const now = new Date();

  if (TERMINAL_OK.has(payout.status)) {
    await settle({
      consignment_id: input.consignment_id,
      actor_user_id: input.actor_user_id,
      provider: "razorpayx",
      reference: payout.id,
      utr: payout.utr,
      at: now,
    });
    const c = (await getConsignment(input.consignment_id, null))!;
    return {
      consignment: c,
      payment_status: "paid",
      payout_id: payout.id,
      utr: payout.utr,
    };
  }

  const failed = TERMINAL_FAIL.has(payout.status);
  await db
    .update(scrapConsignments)
    .set({
      payment_status: failed ? "failed" : "processing",
      payment_provider: "razorpayx",
      payment_ref: payout.id,
      payment_utr: payout.utr ?? null,
      payment_failure_reason: failed
        ? (payout.failureReason ?? `payout ${payout.status}`)
        : null,
      updated_at: now,
    })
    .where(eq(scrapConsignments.id, input.consignment_id));

  const c = (await getConsignment(input.consignment_id, null))!;
  return {
    consignment: c,
    payment_status: failed ? "failed" : "processing",
    payout_id: payout.id,
    utr: payout.utr,
    message: failed
      ? (payout.failureReason ?? `The payout was ${payout.status}.`)
      : `The payout is ${payout.status} — the batteries transfer once the bank confirms it.`,
  };
}

/**
 * Records a payment made outside the app.
 *
 * Deliberately visible, attributed and reference-carrying. The alternative — an
 * admin flipping a status with nobody knowing whether money moved — is exactly
 * what the buyback settlement code was written to end.
 */
export async function recordOfflinePayment(input: {
  consignment_id: string;
  actor_user_id: string | null;
  reference: string;
  note?: string | null;
}): Promise<PayResult> {
  const c = await getConsignment(input.consignment_id, null);
  if (!c) throw new Error("NOT_FOUND: consignment not found");
  await assertPayable(c);
  if (!input.reference.trim()) {
    throw new Error("BAD_REQUEST: a bank reference or UTR is required");
  }

  await settle({
    consignment_id: c.id,
    actor_user_id: input.actor_user_id,
    provider: "offline",
    reference: input.reference.trim(),
    utr: input.reference.trim(),
    at: new Date(),
    note: input.note ?? null,
  });

  const updated = (await getConsignment(c.id, null))!;
  return {
    consignment: updated,
    payment_status: "paid",
    payout_id: null,
    utr: updated.payment_utr,
  };
}

/**
 * The moment the deal completes: money recorded, batteries transferred.
 *
 * ONE TRANSACTION. Marking the consignment paid without transferring the
 * batteries would leave stock the NBFC still believes it owns and iTarang has
 * already paid for — the two halves are the same fact and are written together.
 *
 * The batteries land on `state_code = 'scrapped'` (already a valid state since
 * E-232) with `scrap_consignment_id` set, which is what turns a bare status
 * into "sold to iTarang under SCR-000123". Their items close, releasing the
 * partial unique index — harmless, since a sold battery can never be offered
 * again: `listEligibleBatteries()` excludes anything with a consignment id.
 */
async function settle(input: {
  consignment_id: string;
  actor_user_id: string | null;
  provider: ScrapPaymentProvider;
  reference: string;
  utr: string | null;
  at: Date;
  note?: string | null;
}): Promise<void> {
  const { consignment_id, at } = input;

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(scrapConsignments)
      .set({
        status: "paid",
        payment_status: "paid",
        payment_provider: input.provider,
        payment_ref: input.reference,
        payment_utr: input.utr,
        payment_failure_reason: null,
        paid_at: at,
        paid_by: input.actor_user_id ?? null,
        closed_at: at,
        updated_at: at,
        ...(input.note ? { note: input.note } : {}),
      })
      .where(
        and(
          eq(scrapConsignments.id, consignment_id),
          // Only ever from 'agreed'. A replayed confirm finds nothing to do
          // and leaves the first settlement untouched.
          eq(scrapConsignments.status, "agreed"),
        ),
      )
      .returning({ id: scrapConsignments.id, tenant_id: scrapConsignments.tenant_id });

    if (updated.length === 0) {
      throw new Error(
        "CONFLICT: this consignment is no longer awaiting payment — reload to see its current state",
      );
    }

    const items = await tx
      .select({ battery_id: scrapConsignmentItems.battery_id })
      .from(scrapConsignmentItems)
      .where(eq(scrapConsignmentItems.consignment_id, consignment_id));

    const batteryIds = items
      .map((i) => i.battery_id)
      .filter((id): id is string => !!id);

    if (batteryIds.length > 0) {
      const { inArray } = await import("drizzle-orm");
      await tx
        .update(recoveryBatteries)
        .set({
          state_code: "scrapped",
          scrap_consignment_id: consignment_id,
          updated_at: at,
        })
        .where(inArray(recoveryBatteries.id, batteryIds));
    }

    await tx
      .update(scrapConsignmentItems)
      .set({ is_open: false })
      .where(eq(scrapConsignmentItems.consignment_id, consignment_id));
  });

  const c = await getConsignment(consignment_id, null);
  if (c) {
    await auditScrapAction(
      c.tenant_id,
      input.actor_user_id,
      "scrap_consignment_paid",
      consignment_id,
      {
        ref_code: c.ref_code,
        provider: input.provider,
        reference: input.reference,
        utr: input.utr,
        amount: c.agreed_amount,
        battery_count: c.battery_count,
      },
    );
  }
}
