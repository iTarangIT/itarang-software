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
 *
 * E-281 ADDED THE OTHER DIRECTION. applyItarangCounter (below) is iTarang
 * answering a vendor's counter, and applyVendorResponse gained the
 * `accept_counter` kind — the desk taking their standing price. Both are the
 * mirror of what the dealer leg already had as admin_counter /
 * admin_accept_counter, and both live in this file so the four load-bearing
 * rules above keep having exactly one implementation.
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
import { formatBatteryLine } from "./format";
import { nextRoundNo } from "./queries";
import { standingPriceSql, type AwaitingParty } from "./standing";
import { vendorActionFor } from "./state-machine";
import { applyTransition, loadDealForUpdate, recordActivity } from "./transition";
import type { BuybackTx } from "./tx";
import { threadsForDeal } from "./vendors";

/**
 * What the vendor said — plus, since E-281, the one thing iTarang says through
 * this same machinery.
 *
 * `accept_counter` is NOT a vendor utterance: it is the desk accepting the
 * vendor's standing counter. It rides here rather than in its own function
 * because it is the AGREE branch verbatim — floor guard, first-AGREED-wins, the
 * fill-once lock write, the courteous close — and a second copy of those is a
 * second thing to forget. What differs is the audit verb and that no per-line
 * override is honoured.
 */
export type VendorResponseKind = "counter" | "agree" | "reject" | "accept_counter";

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
  /**
   * E-281 — whose move it is. The status alone cannot say: a thread is COUNTERED
   * both while we owe the vendor a reply and after we have sent one.
   */
  awaitingParty: AwaitingParty;
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

  // E-281 — accepting a counter requires there to BE one, and requires it to be
  // ours to accept. A thread we have already answered is waiting on the vendor;
  // "accepting" there would be accepting our own last offer on their behalf.
  if (kind === "accept_counter") {
    if (thread.status !== "COUNTERED") {
      throw new ValidationError(
        "This vendor has not countered, so there is no price of theirs to accept. They are still holding the quotation at our ask.",
      );
    }
    if (thread.awaitingParty !== "ITARANG") {
      throw new ValidationError(
        "iTarang has already countered this vendor — the ball is with them. Wait for their reply, or counter again.",
      );
    }
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
      .set({
        status: "COUNTERED",
        // E-281 — the ball comes back to us. This is what puts Counter / Accept
        // on the thread card, and what makes standingPriceSql read THEIR number
        // again after we had countered.
        awaiting_party: "ITARANG",
        responded_at: new Date(),
        updated_at: new Date(),
      })
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
        // Whose OFFER it is — always the vendor here, however it was entered.
        // This is the column that keeps an admin's transcript of their counter
        // distinguishable from iTarang's own counter, which also lands on this
        // leg with offered_by_role='admin' (E-281).
        party: "VENDOR",
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
  // Default to the STANDING prices — the last number either side put on the
  // table, resolved by standingPriceSql (E-281). This used to be a plain
  // COALESCE(counter_price, ask_price), which was correct only while the vendor
  // was the sole party who could move a number after routing. Once iTarang can
  // counter back, that expression makes a vendor who clicks "Accept" on OUR
  // counter agree to THEIR OWN earlier number — which is below the floor by
  // construction, so assertClearsFloor below would refuse the very price we had
  // just offered them.
  const standing = await tx.execute(sql`
    SELECT vtl.line_id,
           ${standingPriceSql("vtl", "vt")} AS price,
           bl.quantity
    FROM vendor_thread_lines vtl
    JOIN vendor_threads vt ON vt.id = vtl.thread_id
    JOIN buyback_lines bl ON bl.id = vtl.line_id
    WHERE vtl.thread_id = ${thread.id}
  `);

  // An override is a HUMAN transcribing a figure negotiated off-system, which is
  // what `agree` by an admin means. `accept_counter` means "yes, at the number
  // already on the table" — honouring an override there would let the desk book
  // an agreement at a price the vendor never named, under a verb that claims they
  // did. Naming a different number is a counter.
  const override =
    kind === "accept_counter"
      ? new Map<string, number>()
      : new Map((lines ?? []).map((l) => [l.line_id, l.price]));

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
    action: vendorActionFor(kind === "accept_counter" ? "accept_counter" : "agree", actor.role),
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
      // E-281 — the WINNER, but only when iTarang is the one saying yes. On a
      // plain `agree` the vendor already knows: they either said it themselves or
      // said it in the email an admin is transcribing. On `accept_counter` the
      // desk moved and nobody has told them their price was taken — which is the
      // moment they are committed to buying a lot.
      ...(kind === "accept_counter" && thread.vendorEmail
        ? (["EMAIL", "PORTAL"] as const).map((channel) => ({
            party: "VENDOR" as const,
            channel,
            recipientRef: thread.vendorEmail!,
            discriminator: `won:${channel.toLowerCase()}`,
            payload: {
              kind: "vendor_counter_accepted",
              thread_id: thread.id,
              vendor_name: thread.vendorName,
              quotation_no: thread.quotationNo,
              // Their own agreed total. Not the floor, not the dealer, not the
              // margin — the same line every vendor payload holds.
              agreed_total: floor.total,
              lines: agreed.map((l) => ({ line_id: l.line_id, price: l.price })),
            },
          }))
        : []),
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

/**
 * iTarang countering a vendor's counter, per SKU (E-281, M10).
 *
 * The move the vendor leg never had. Before this the desk's only answers to a
 * counter were "agree" and "reopen the dealer leg" — and reopen bumps
 * offer_version and forces every open thread to LOST, so the routine act of
 * naming a different number could only be expressed by withdrawing the auction.
 *
 * Separate from applyVendorResponse rather than a fifth `kind`, because almost
 * nothing is shared: this writes a different column, flips the ball the other
 * way, moves no lock, closes no thread, and — the reason that matters — runs the
 * floor guard for the OPPOSITE reason. There, the floor stops us ACCEPTING too
 * little. Here it stops us OFFERING too little: a counter below the floor is a
 * price we would be forbidden to accept if the vendor said yes, which is a trap
 * we would be laying for ourselves.
 *
 * The caller has already proved staff. There is no vendor path into this
 * function and there should not be one — a vendor "countering" is
 * applyVendorResponse's `counter`.
 */
export interface ItarangCounterInput {
  tx: BuybackTx;
  thread: VendorThreadContext;
  actor: { id: string; role: "admin" };
  /** Per SKU, always. Every line on the thread must be priced. */
  lines: Array<{ line_id: string; price: number }>;
  note?: string;
}

export interface ItarangCounterOutcome {
  status: string;
  thread_status: "COUNTERED";
  round_no: number;
  our_total: number;
  floor_total: number;
}

export async function applyItarangCounter({
  tx,
  thread,
  actor,
  lines,
  note,
}: ItarangCounterInput): Promise<ItarangCounterOutcome> {
  if (thread.status === "AGREED" || thread.status === "LOST") {
    throw new ValidationError(
      `This thread is already ${thread.status}. Reopen the deal to re-engage this vendor.`,
    );
  }

  // Countering something they have not said is not a counter. A thread still at
  // SENT is holding our opening ask; changing that number is a re-quote, which
  // is deliberately not this feature (the other vendors hold the old PDF).
  if (thread.status !== "COUNTERED") {
    throw new ValidationError(
      "This vendor has not countered yet — they are still holding the quotation at our ask, so there is nothing to counter back.",
    );
  }

  if (thread.awaitingParty !== "ITARANG") {
    throw new ValidationError(
      "iTarang has already countered this vendor and the ball is with them. Wait for their reply before countering again.",
    );
  }

  const deal = await loadDealForUpdate(tx, thread.requestId);
  if (!deal) throw new NotFoundError("Deal not found.");

  // Itemized, always (P5) — the same rule the vendor's own counter obeys, and
  // for the same reason: a lump sum is not a price anyone can agree to per SKU.
  // The spec columns come along because the counter EMAIL has to be readable:
  // "60V 120Ah · Working — ₹78/u" is a price a vendor can act on, a bare uuid is
  // not. Same shared formatter every other buyback surface uses (invariant 7).
  const existing = await tx.execute(sql`
    SELECT vtl.line_id, bl.quantity, bl.condition, cv.voltage, cv.ah
    FROM vendor_thread_lines vtl
    JOIN buyback_lines bl        ON bl.id = vtl.line_id
    LEFT JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE vtl.thread_id = ${thread.id}
    ORDER BY cv.voltage, cv.ah
  `);

  const threadLines = existing as unknown as Array<{
    line_id: string;
    quantity: number;
    condition: "WORKING" | "DEAD";
    voltage: string;
    ah: string;
  }>;
  if (threadLines.length === 0) {
    throw new ValidationError("This vendor's quotation has no lines to counter.");
  }

  const priced = new Map(lines.map((l) => [l.line_id, l.price]));

  for (const line_id of priced.keys()) {
    if (!threadLines.some((l) => l.line_id === line_id)) {
      throw new ValidationError("A priced line does not belong to this vendor's quotation.");
    }
  }

  // Every line, not just the ones being moved. A partial counter leaves the other
  // SKUs at whichever side's number happened to be standing, so "what did we
  // offer?" would have to be reassembled from two rounds — and the round we write
  // below would not be a complete offer, which is what a round is.
  if (priced.size !== threadLines.length) {
    throw new ValidationError(
      "A counter must price every battery variant on this vendor's quotation.",
    );
  }

  const ours = threadLines.map((l) => {
    const f = formatBatteryLine({
      id: l.line_id,
      quantity: Number(l.quantity),
      condition: l.condition,
      voltage: l.voltage,
      ah: l.ah,
    });
    return {
      line_id: l.line_id,
      quantity: Number(l.quantity),
      price: priced.get(l.line_id)!,
      label: `${f.specLabel} · ${f.condition}`,
    };
  });

  // THE FLOOR, pointed outward. Refused, not warned about: offering below it
  // would commit us to a number we could not legally accept when they said yes.
  const floor = assertClearsFloor(ours, thread.floorTotal);

  for (const line of ours) {
    await tx
      .update(vendorThreadLines)
      .set({ revised_ask_price: line.price.toString(), updated_at: new Date() })
      .where(
        and(
          eq(vendorThreadLines.thread_id, thread.id),
          eq(vendorThreadLines.line_id, line.line_id),
        ),
      );
  }

  // Status stays COUNTERED — the negotiation is open and they may still answer.
  // Only the ball moves.
  await tx
    .update(vendorThreads)
    .set({ awaiting_party: "VENDOR", updated_at: new Date() })
    .where(eq(vendorThreads.id, thread.id));

  const roundNo = await nextRoundNo(tx, deal.id, "VENDOR");

  const [round] = await tx
    .insert(negotiationRounds)
    .values({
      deal_id: deal.id,
      leg: "VENDOR",
      counterparty_id: thread.vendorId,
      round_no: roundNo,
      offered_by: actor.id,
      // WHO TYPED IT is an admin; WHOSE OFFER IT IS is iTarang. On the vendor leg
      // those two had the same value until now and 'admin' meant "transcribed on
      // the vendor's behalf" — party is what keeps the audit log able to tell an
      // offer of ours from a transcript of theirs (E-281).
      offered_by_role: "admin",
      party: "ITARANG",
      note: note ?? null,
    })
    .returning({ id: negotiationRounds.id });

  await tx.insert(negotiationRoundLines).values(
    ours.map((l) => ({
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
    action: "counter_vendor",
    actor,
    after: {
      thread: thread.id,
      vendor: thread.vendorName,
      round_no: roundNo,
      our_total: floor.total,
      lines: ours.map((l) => ({ line_id: l.line_id, price: l.price })),
    },
    // Several vendors may be countered within one offer version, and one vendor
    // may be countered repeatedly. Without the discriminator the second counter
    // collides with the first on the idempotency key and the vendor is never told.
    eventDiscriminator: `${thread.id}:${roundNo}`,
    notificationPayload: {
      request_no: thread.requestNo,
      vendor_name: thread.vendorName,
      round_no: roundNo,
    },
    // The vendor hears it twice — by email, because that is how they were quoted
    // and many never log in, and in the portal bell for the ones who do.
    //
    // The payload carries our per-SKU ask and NOTHING else. No floor_total (that
    // is dealer_price + margin — our whole position), no dealer, no margin.
    fanOut: thread.vendorEmail
      ? (["EMAIL", "PORTAL"] as const).map((channel) => ({
          party: "VENDOR" as const,
          channel,
          recipientRef: thread.vendorEmail!,
          discriminator: `counter:${roundNo}:${channel.toLowerCase()}`,
          payload: {
            kind: "vendor_countered_by_itarang",
            thread_id: thread.id,
            vendor_name: thread.vendorName,
            quotation_no: thread.quotationNo,
            round_no: roundNo,
            our_total: floor.total,
            note: note ?? null,
            lines: ours.map((l) => ({
              line_id: l.line_id,
              label: l.label,
              quantity: l.quantity,
              price: l.price,
            })),
          },
        }))
      : undefined,
  });

  return {
    status: result.to,
    thread_status: "COUNTERED",
    round_no: roundNo,
    our_total: floor.total,
    floor_total: floor.floor,
  };
}
