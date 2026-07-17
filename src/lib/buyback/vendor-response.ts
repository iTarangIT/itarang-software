/**
 * A vendor's answer to a quotation — counter, agree, or walk away (M10).
 *
 * ONE implementation, TWO callers, because the same event now arrives by two
 * routes:
 *
 *   · an admin RECORDING what a vendor said in an email
 *       (POST /api/admin/buyback/threads/:id/record)
 *   · the vendor saying it themselves, from their dashboard  (E-195)
 *       (POST /api/vendor/threads/:id/respond)
 *
 * Both paths stay. A vendor who replies to the quotation email instead of
 * logging in still has to reach the system somehow, and that is still an admin
 * typing it in. What differs between them is only WHO is speaking — which
 * changes the audit trail and the state-machine action, and nothing else.
 *
 * WHY THIS IS A LIB AND NOT COPY-PASTE. Four things in here are load-bearing,
 * and a second copy of any of them is a second thing to forget:
 *
 *   1. THE FLOOR (M10). A below-floor agreement is REFUSED — 422, no override.
 *      The floor is dealer_price + margin; agreeing under it sells the lot for
 *      less than we have already promised the dealer, which is a loss booked
 *      silently. A drifted copy of this check is a copy that eventually says
 *      yes.
 *   2. FIRST AGREED WINS, atomically. Not because this code is careful: the
 *      partial unique index `vendor_threads_one_agreed_per_deal` means the
 *      second concurrent agreement fails at the database. A deal cannot end up
 *      owing its batteries to two buyers.
 *   3. FILL-ONCE vendor_price on deal_line_locks — the single write E-186's
 *      trigger permits, and the row every document and report reads the deal's
 *      whole economics from.
 *   4. THE COURTEOUS CLOSE, which must never carry the winning price. A losing
 *      vendor learning what beat them learns our position.
 *
 * ITEMIZED, ALWAYS. Every price here is per SKU (P5). The prototype averaged
 * per-line amounts into one number, which destroys the itemization the module
 * is built on and is not a price anyone agreed to.
 */

import { and, eq, ne, notInArray, sql } from "drizzle-orm";

import {
  negotiationRoundLines,
  negotiationRounds,
  vendorThreadLines,
  vendorThreads,
} from "@/lib/db/schema";
import { NotFoundError, ValidationError } from "./errors";
import { assertClearsFloor } from "./floor";
import { nextRoundNo } from "./queries";
import { vendorActionFor } from "./state-machine";
import { applyTransition, loadDealForUpdate, recordActivity } from "./transition";
import type { BuybackTx } from "./tx";
import { threadsForDeal } from "./vendors";

/** What the vendor said. */
export type VendorResponseKind = "counter" | "agree" | "reject";

/** Who is saying it — and therefore what the audit trail will claim. */
export type VendorResponseActor =
  /** An admin transcribing an email. Hearsay, and recorded as such. */
  | { id: string; role: "admin" }
  /** The vendor, from their own login. First-hand. */
  | { id: string; role: "vendor" };

export interface VendorThreadContext {
  id: string;
  dealId: string;
  vendorId: string;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  quotationNo: string | null;
  requestId: string;
  requestNo: string;
  floorTotal: string | null;
  vendorName: string;
  vendorEmail: string | null;
}

export interface VendorResponseInput {
  tx: BuybackTx;
  thread: VendorThreadContext;
  actor: VendorResponseActor;
  kind: VendorResponseKind;
  /** Per-SKU. Required for a counter; optional for an agree (defaults to standing prices). */
  lines?: Array<{ line_id: string; price: number }>;
  note?: string;
}

export interface VendorResponseOutcome {
  status: string;
  thread_status: "COUNTERED" | "AGREED" | "LOST";
  round_no?: number;
  agreed_total?: number;
  floor_total?: number;
  lost_threads?: number;
}

/**
 * Apply a vendor's response inside an open transaction.
 *
 * Caller is responsible for authorisation — an admin route proves staff, a
 * vendor route proves the thread is theirs. This function trusts `thread`.
 */
export async function applyVendorResponse({
  tx,
  thread,
  actor,
  kind,
  lines,
  note,
}: VendorResponseInput): Promise<VendorResponseOutcome> {
  if (thread.status === "AGREED" || thread.status === "LOST") {
    throw new ValidationError(
      `This thread is already ${thread.status}. Reopen the deal to re-engage this vendor.`,
    );
  }

  if (kind === "counter" && (!lines || lines.length === 0)) {
    // The one thing a vendor may not do is name a single number for the lot.
    throw new ValidationError(
      "A vendor counter must be itemized per battery variant — a lump-sum figure for the whole lot cannot be recorded.",
    );
  }

  const deal = await loadDealForUpdate(tx, thread.requestId);
  if (!deal) throw new NotFoundError("Deal not found.");

  // ------------------------------------------------------------------ REJECT
  // A vendor dropping out changes the THREAD, not the deal — the other vendors
  // are still live. So no transition: an audit row, and that is all.
  if (kind === "reject") {
    await tx
      .update(vendorThreads)
      .set({
        status: "LOST",
        close_reason: note ?? "vendor declined",
        closed_at: new Date(),
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(vendorThreads.id, thread.id));

    await recordActivity({
      tx,
      requestId: thread.requestId,
      dealId: deal.id,
      actor,
      action: "vendor_declined",
      before: { thread: thread.id, status: thread.status },
      after: { thread: thread.id, status: "LOST", vendor: thread.vendorName },
    });

    return { status: deal.status, thread_status: "LOST" };
  }

  // Every priced line must belong to THIS vendor's quotation. Without this an
  // admin (or a vendor posting a handcrafted body) could price a line on
  // somebody else's thread.
  const existing = await tx
    .select({ line_id: vendorThreadLines.line_id })
    .from(vendorThreadLines)
    .where(eq(vendorThreadLines.thread_id, thread.id));

  const known = new Set(existing.map((l) => l.line_id));

  for (const entry of lines ?? []) {
    if (!known.has(entry.line_id)) {
      throw new ValidationError("A priced line does not belong to this vendor's quotation.");
    }
  }

  // ----------------------------------------------------------------- COUNTER
  if (kind === "counter") {
    for (const entry of lines!) {
      await tx
        .update(vendorThreadLines)
        .set({ counter_price: entry.price.toString(), updated_at: new Date() })
        .where(
          and(
            eq(vendorThreadLines.thread_id, thread.id),
            eq(vendorThreadLines.line_id, entry.line_id),
          ),
        );
    }

    await tx
      .update(vendorThreads)
      .set({ status: "COUNTERED", responded_at: new Date(), updated_at: new Date() })
      .where(eq(vendorThreads.id, thread.id));

    // The round, on the VENDOR leg — same tables as the dealer leg, itemized
    // the same way. `negotiation_rounds` has no amount column; the amounts live
    // on its *_lines child, so a lump sum is unrepresentable here too.
    const roundNo = await nextRoundNo(tx, deal.id, "VENDOR");

    const [round] = await tx
      .insert(negotiationRounds)
      .values({
        deal_id: deal.id,
        leg: "VENDOR",
        counterparty_id: thread.vendorId,
        round_no: roundNo,
        offered_by: actor.id,
        // Who actually typed it. 'admin' means recorded on the vendor's behalf;
        // 'vendor' means they said it themselves.
        offered_by_role: actor.role,
        note: note ?? null,
      })
      .returning({ id: negotiationRounds.id });

    await tx.insert(negotiationRoundLines).values(
      lines!.map((l) => ({
        round_id: round.id,
        line_id: l.line_id,
        offered_price_per_unit: l.price.toString(),
      })),
    );

    const result = await applyTransition({
      tx,
      dealId: deal.id,
      requestId: thread.requestId,
      currentStatus: deal.status,
      offerVersion: deal.offer_version,
      action: vendorActionFor("counter", actor.role),
      actor,
      after: {
        thread: thread.id,
        vendor: thread.vendorName,
        round_no: roundNo,
        lines,
      },
      // Several vendors may counter within one offer version, and one vendor may
      // counter repeatedly. Without a discriminator the second counter would
      // collide with the first on the unique key and be swallowed — a vendor
      // would counter and nobody would be told.
      eventDiscriminator: `${thread.id}:${roundNo}`,
      notificationPayload: {
        request_no: thread.requestNo,
        vendor_name: thread.vendorName,
        round_no: roundNo,
      },
    });

    return { status: result.to, thread_status: "COUNTERED", round_no: roundNo };
  }

  // ------------------------------------------------------------------- AGREE
  // Default to the standing prices: their counter where they made one, our ask
  // where they did not. A caller can still override per line.
  const standing = await tx.execute(sql`
    SELECT vtl.line_id,
           COALESCE(vtl.counter_price, vtl.ask_price) AS price,
           bl.quantity
    FROM vendor_thread_lines vtl
    JOIN buyback_lines bl ON bl.id = vtl.line_id
    WHERE vtl.thread_id = ${thread.id}
  `);

  const override = new Map((lines ?? []).map((l) => [l.line_id, l.price]));

  const agreed = (
    standing as unknown as Array<{ line_id: string; price: string; quantity: number }>
  ).map((row) => ({
    line_id: row.line_id,
    quantity: Number(row.quantity),
    price: override.get(row.line_id) ?? Number(row.price),
  }));

  if (agreed.length === 0) {
    throw new ValidationError("This vendor's quotation has no lines to agree to.");
  }

  // THE FLOOR (M10). Refused, not warned about. Throws a 422 carrying the
  // shortfall so the desk can decide: push the vendor, or reopen the dealer
  // leg. There is deliberately no override — and note this applies identically
  // to a VENDOR agreeing from their own dashboard. A vendor cannot accept a
  // price we cannot afford to sell at, however they enter it.
  const floor = assertClearsFloor(agreed, thread.floorTotal);

  for (const line of agreed) {
    await tx
      .update(vendorThreadLines)
      .set({ agreed_price: line.price.toString(), updated_at: new Date() })
      .where(
        and(
          eq(vendorThreadLines.thread_id, thread.id),
          eq(vendorThreadLines.line_id, line.line_id),
        ),
      );
  }

  // The winner. If another thread on this deal is already AGREED, the partial
  // unique index rejects this UPDATE and the whole transaction rolls back.
  await tx
    .update(vendorThreads)
    .set({
      status: "AGREED",
      responded_at: new Date(),
      closed_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(vendorThreads.id, thread.id));

  // Everyone else, atomically, in the same transaction (M10).
  const losers = await tx
    .update(vendorThreads)
    .set({
      status: "LOST",
      close_reason: "another vendor agreed",
      closed_at: new Date(),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(vendorThreads.deal_id, deal.id),
        ne(vendorThreads.id, thread.id),
        notInArray(vendorThreads.status, ["AGREED", "LOST"]),
      ),
    )
    .returning({ id: vendorThreads.id, vendor_id: vendorThreads.vendor_id });

  // Fill vendor_price into the locks — the ONE write E-186's fill-once trigger
  // permits. After this, every document and every report reads the whole
  // economics of the deal from a single row per SKU: what we pay the dealer,
  // our margin, and what the vendor pays us.
  for (const line of agreed) {
    await tx.execute(sql`
      UPDATE deal_line_locks
      SET vendor_price = ${line.price.toString()}
      WHERE deal_id = ${deal.id}
        AND line_id = ${line.line_id}
        AND offer_version = ${deal.offer_version}
    `);
  }

  // Who the losers are, for the courteous close (M10).
  const allThreads = await threadsForDeal(deal.id, tx);
  const lostIds = new Set(losers.map((l) => l.id));
  const closing = allThreads.filter((t) => lostIds.has(t.id) && t.vendor_email);

  const result = await applyTransition({
    tx,
    dealId: deal.id,
    requestId: thread.requestId,
    currentStatus: deal.status,
    offerVersion: deal.offer_version,
    action: vendorActionFor("agree", actor.role),
    actor,
    after: {
      thread: thread.id,
      vendor: thread.vendorName,
      agreed_total: floor.total,
      floor_total: floor.floor,
      lines: agreed,
      lost: losers.length,
    },
    // One state change, several messages: the admins get a portal ping, and
    // every losing vendor gets a courteous close (M10) — each its own event,
    // its own recipient, its own idempotency key.
    fanOut: [
      {
        party: "ADMIN",
        channel: "PORTAL",
        discriminator: "portal",
        payload: {
          request_no: thread.requestNo,
          vendor_name: thread.vendorName,
          agreed_total: floor.total,
          lost: losers.length,
        },
      },
      ...closing.map((t) => ({
        party: "VENDOR" as const,
        channel: "EMAIL" as const,
        recipientRef: t.vendor_email,
        discriminator: `lost:${t.id}`,
        payload: {
          kind: "vendor_lost",
          thread_id: t.id,
          vendor_name: t.vendor_name,
          quotation_no: t.quotation_no,
          // Note what is NOT here: the winning price. A losing vendor must not
          // learn what they were beaten by.
        },
      })),
    ],
  });

  return {
    status: result.to,
    thread_status: "AGREED",
    agreed_total: floor.total,
    floor_total: floor.floor,
    lost_threads: losers.length,
  };
}
