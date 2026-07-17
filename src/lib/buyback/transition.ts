/**
 * peakAmp — THE choke point. The only code path allowed to change a deal's status.
 *
 * Every mutating buyback route calls applyTransition inside a db.transaction.
 * In that one transaction it:
 *
 *   1. validates (state, action, role) against the pure state machine  → invariant 3
 *   2. writes the new status onto buyback_deals                         (the only writer)
 *   3. INSERTs the activity_log row                                     → invariant 5
 *   4. INSERTs exactly one notification event                           → invariant 6
 *
 * Because 2/3/4 cannot happen without each other, "a state change with no audit
 * row" and "a silent transition with no notification" are not reachable states of
 * the code. That is the whole point — they are not policed by review, they are
 * unrepresentable.
 *
 * DO NOT write `db.update(buybackDeals).set({ status })` anywhere else.
 */

import { and, eq, sql } from "drizzle-orm";

import {
  buybackActivityLog,
  buybackDeals,
  buybackNotificationEvents,
} from "@/lib/db/schema";
import { TransitionError } from "./errors";
import {
  transition,
  type ActorRole,
  type DealAction,
  type DealState,
} from "./state-machine";
import type { BuybackTx } from "./tx";

/**
 * Who hears about each action, and how (BRD M20/U4 — WhatsApp for dealers,
 * portal for admins; email is the vendor leg, Sprint 2).
 *
 * Every action MUST appear here. The exhaustive test asserts that, so a new
 * action cannot be added without deciding who gets told — which is exactly the
 * "no silent transitions" AC.
 */
export const NOTIFICATION_FOR: Record<
  DealAction,
  { party: "DEALER" | "ADMIN" | "VENDOR"; channel: "WHATSAPP" | "EMAIL" | "PORTAL" }
> = {
  // Dealer acted → tell the admins, in-portal.
  submit: { party: "ADMIN", channel: "PORTAL" },
  resubmit: { party: "ADMIN", channel: "PORTAL" },
  dealer_counter: { party: "ADMIN", channel: "PORTAL" },
  dealer_accept: { party: "ADMIN", channel: "PORTAL" },
  dealer_decline: { party: "ADMIN", channel: "PORTAL" },

  // Admin acted → tell the dealer, on WhatsApp.
  accept: { party: "DEALER", channel: "WHATSAPP" },
  reject: { party: "DEALER", channel: "WHATSAPP" },
  negotiate: { party: "DEALER", channel: "WHATSAPP" },
  request_info: { party: "DEALER", channel: "WHATSAPP" },
  send_final_offer: { party: "DEALER", channel: "WHATSAPP" },
  reopen: { party: "DEALER", channel: "WHATSAPP" },
  cancel: { party: "DEALER", channel: "WHATSAPP" },

  // Internal bookkeeping — the dealer does not need to hear that an admin
  // opened their request, or what margin was set (they must never hear that).
  start_review: { party: "ADMIN", channel: "PORTAL" },
  set_margin: { party: "ADMIN", channel: "PORTAL" },

  // --- Vendor leg (Sprint 2A) ---
  // These are the DEFAULTS. route_to_vendors and record_vendor_agreement both
  // override them with a `fanOut` (N vendors get quotations; every losing vendor
  // gets a courteous close), so what is listed here is the ADMIN-facing portal
  // event that always accompanies them.
  route_to_vendors: { party: "ADMIN", channel: "PORTAL" },
  record_vendor_counter: { party: "ADMIN", channel: "PORTAL" },
  record_vendor_agreement: { party: "ADMIN", channel: "PORTAL" },

  // --- Vendor leg, first-hand (E-195 — the vendor login) ---
  // A counterparty moved, so the desk hears about it in-portal — the same shape
  // as dealer_counter/dealer_accept above, for the same reason.
  //
  // NOT the dealer, on either. A dealer must never learn what a vendor offered:
  // the gap between the two prices is iTarang's margin, and telling the seller
  // what the buyer paid is the one disclosure this whole module is built to
  // prevent. Same rule that makes record_settlement fan out rather than
  // broadcast.
  //
  // vendor_agree's route overrides with a fanOut, exactly as
  // record_vendor_agreement does, so every losing vendor still gets the
  // courteous close rather than silence.
  vendor_counter: { party: "ADMIN", channel: "PORTAL" },
  vendor_agree: { party: "ADMIN", channel: "PORTAL" },

  // Fulfilment — the dealer is the one who has to be somewhere at a time, so
  // these reach them on WhatsApp. The vendor's own PO copy is handled by the
  // fan-out on exchange_pos.
  exchange_pos: { party: "DEALER", channel: "WHATSAPP" },
  schedule_pickup: { party: "DEALER", channel: "WHATSAPP" },
  complete_pickup: { party: "DEALER", channel: "WHATSAPP" },

  // --- Money leg (Sprint 2B) ---
  // The dealer raised it, so the admins are the ones who need to know.
  raise_invoice: { party: "ADMIN", channel: "PORTAL" },
  // These two are the dealer's money. They hear about both — especially the
  // rejection, which carries the reason and needs them to act.
  approve_invoice: { party: "DEALER", channel: "WHATSAPP" },
  return_invoice: { party: "DEALER", channel: "WHATSAPP" },
  // Default recipient; the routes override with a fanOut so the party who was
  // actually paid is the one told (a dealer must not be notified that a VENDOR
  // paid us, and must never learn the vendor's figure).
  record_settlement: { party: "ADMIN", channel: "PORTAL" },
  settle: { party: "ADMIN", channel: "PORTAL" },
  close_deal: { party: "ADMIN", channel: "PORTAL" },
};

/**
 * One outbound message caused by a transition.
 *
 * `recipientRef` (an email address, a phone number) and `attachmentS3Key` are
 * SNAPSHOTTED here, at emit time. The dispatcher must never re-derive a
 * recipient: a vendor's address can be edited between the transition and the
 * send, and the audit trail has to record where the message actually went — not
 * where it would go if we sent it today.
 */
export interface NotificationTarget {
  party: "DEALER" | "ADMIN" | "VENDOR";
  channel: "WHATSAPP" | "EMAIL" | "PORTAL";
  recipientRef?: string | null;
  attachmentS3Key?: string | null;
  /** Makes this event's idempotency key unique among the transition's fan-out. */
  discriminator: string | number;
  payload?: Record<string, unknown>;
}

export interface ApplyTransitionArgs {
  /** The open transaction. Required — this cannot run outside one. */
  tx: BuybackTx;
  dealId: string;
  requestId: string;
  /** The status read inside this transaction. */
  currentStatus: DealState;
  /** The deal's offer_version, read inside this transaction. */
  offerVersion: number;
  action: DealAction;
  actor: { id: string | null; role: ActorRole };
  /** before → after for prices and the like (BRD M21). */
  before?: unknown;
  after?: unknown;
  /**
   * Disambiguates repeated occurrences of the same action at the same offer
   * version — a dealer may counter many times inside one version, and each
   * counter is its own event. Pass the round number, the final-offer id, etc.
   * Omit for actions that can only happen once per version.
   */
  eventDiscriminator?: string | number;
  /** Extra context for the notification body (line prices, targeted units…). */
  notificationPayload?: Record<string, unknown>;
  /** Set by `reopen`, which bumps the version as part of the same transition. */
  bumpOfferVersion?: boolean;
  /**
   * One transition, several outbound messages — routing quotes N vendors; an
   * agreement closes out every loser. When omitted, the single default recipient
   * from NOTIFICATION_FOR is used (Sprint 1's behaviour, unchanged).
   */
  fanOut?: NotificationTarget[];
}

export interface TransitionOutcome {
  from: DealState;
  to: DealState;
  offerVersion: number;
}

export async function applyTransition({
  tx,
  dealId,
  requestId,
  currentStatus,
  offerVersion,
  action,
  actor,
  before,
  after,
  eventDiscriminator,
  notificationPayload,
  bumpOfferVersion = false,
  fanOut,
}: ApplyTransitionArgs): Promise<TransitionOutcome> {
  // 1. The gate. A refusal is a 409 — never "hide the button".
  const result = transition(currentStatus, action, actor.role);
  if (!result.ok) {
    throw new TransitionError(result.reason);
  }

  const nextVersion = bumpOfferVersion ? offerVersion + 1 : offerVersion;

  // 2. The status write. Guarded on the status we validated against, so two
  //    concurrent admins cannot both win a race (the loser updates 0 rows).
  const updated = await tx
    .update(buybackDeals)
    .set({
      status: result.to,
      offer_version: nextVersion,
      updated_at: new Date(),
      ...(result.to === "MARGIN_SET" ? { locked_at: new Date() } : {}),
    })
    .where(and(eq(buybackDeals.id, dealId), eq(buybackDeals.status, currentStatus)))
    .returning({ id: buybackDeals.id });

  if (updated.length === 0) {
    // Someone else moved the deal between our read and our write.
    throw new TransitionError(
      `The deal is no longer ${currentStatus} — it was changed by someone else. Reload and try again.`,
    );
  }

  // 3. The audit row. Same transaction, by construction (invariant 5).
  await tx.insert(buybackActivityLog).values({
    request_id: requestId,
    deal_id: dealId,
    actor_id: actor.id,
    role: actor.role,
    action,
    before: (before ?? { status: currentStatus }) as never,
    after: (after ?? { status: result.to }) as never,
  });

  // 4. The notification events (invariant 6).
  //
  //    Sprint 1's rule was "exactly one event per state change". That was right
  //    while every transition had exactly one recipient. It is not right for the
  //    vendor leg: routing a deal is ONE state change but N quotation emails,
  //    each needing its own message_id logged (U6); a vendor agreement is one
  //    state change but a courteous close to every losing vendor.
  //
  //    So the rule the code actually enforces — and the one that protects what
  //    the AC cares about — is:
  //
  //        every transition emits AT LEAST ONE event, one per recipient,
  //        each with its own UNIQUE idempotency key.
  //
  //    Zero events is still a silent transition (a bug). A duplicate message is
  //    still impossible (the unique key refuses it on retry). What is now
  //    allowed is a fan-out, which is what actually happens in the world.
  const targets: NotificationTarget[] =
    fanOut && fanOut.length > 0
      ? fanOut
      : [
          {
            ...NOTIFICATION_FOR[action],
            discriminator: eventDiscriminator ?? "",
            payload: notificationPayload,
          },
        ];

  // Resolve the DEALER's address here, at emit time, if the caller has not
  // supplied one.
  //
  // This is not a convenience — it is the difference between a dispatcher that
  // works and one that doesn't. Every dealer-bound event is WhatsApp, and the
  // dispatcher needs a number to send to. Sprint 1 wrote its events before the
  // recipient_ref column existed, so without this every one of them would fail
  // with "no recipient_ref" the moment the dispatcher was switched on.
  //
  // Resolved once, here, and STORED — not looked up at send time. If the dealer
  // changes their number tomorrow, the audit trail must still say where we
  // actually sent this message today. (A VENDOR recipient is never resolved here:
  // one deal has many vendors, so only the caller knows which one this event is
  // for, and it passes recipientRef explicitly.)
  const needsDealerRef = targets.some(
    (t) => t.party === "DEALER" && t.channel !== "PORTAL" && !t.recipientRef,
  );

  let dealerPhone: string | null = null;
  let dealerEmail: string | null = null;

  if (needsDealerRef) {
    const rows = await tx.execute(sql`
      SELECT a.contact_phone, a.contact_email
      FROM buyback_requests br
      JOIN accounts a ON a.id = br.dealer_entity_id
      WHERE br.id = ${requestId}
      LIMIT 1
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    dealerPhone = (row?.contact_phone as string) ?? null;
    dealerEmail = (row?.contact_email as string) ?? null;
  }

  const resolveRef = (t: NotificationTarget): string | null => {
    if (t.recipientRef) return t.recipientRef;
    if (t.party !== "DEALER") return null;
    if (t.channel === "WHATSAPP") return dealerPhone;
    if (t.channel === "EMAIL") return dealerEmail;
    return null;
  };

  await tx.insert(buybackNotificationEvents).values(
    targets.map((target) => ({
      deal_id: dealId,
      request_id: requestId,
      event_type: action,
      recipient_party: target.party,
      channel: target.channel,
      recipient_ref: resolveRef(target),
      attachment_s3_key: target.attachmentS3Key ?? null,
      idempotency_key: eventKey(
        dealId,
        action,
        nextVersion,
        target.discriminator === "" ? undefined : target.discriminator,
      ),
      payload: {
        from: currentStatus,
        to: result.to,
        offer_version: nextVersion,
        ...(target.payload ?? {}),
      } as never,
    })),
  );

  return { from: currentStatus, to: result.to, offerVersion: nextVersion };
}

/**
 * An audit row for a change that is NOT a state transition.
 *
 * Sprint 1 had no such thing: every change moved the deal, so applyTransition
 * covered everything. The vendor leg breaks that. Marking one vendor LOST while
 * three others are still live changes real state — the thread's — but moves no
 * DEAL status, and forcing it through applyTransition would mean inventing a
 * self-loop transition that exists only to satisfy the audit log.
 *
 * BRD M21 says activity_log is written "in the same transaction as every
 * change", not "as every transition". This is that. It takes a tx handle by
 * signature, for the same reason applyTransition does: it cannot be called
 * outside a transaction.
 *
 * No notification is emitted. Nobody outside iTarang is affected by a thread
 * being closed — except a losing vendor, who is told as part of the AGREEMENT's
 * fan-out, where the courteous close belongs.
 */
export async function recordActivity({
  tx,
  requestId,
  dealId,
  actor,
  action,
  before,
  after,
}: {
  tx: BuybackTx;
  requestId: string;
  dealId: string;
  actor: { id: string | null; role: ActorRole };
  action: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await tx.insert(buybackActivityLog).values({
    request_id: requestId,
    deal_id: dealId,
    actor_id: actor.id,
    role: actor.role,
    action,
    before: (before ?? null) as never,
    after: (after ?? null) as never,
  });
}

/**
 * '{deal}:{action}:{version}[:{discriminator}]'.
 *
 * Without the discriminator, a dealer's second counter inside the same offer
 * version would collide with their first and be swallowed as a duplicate — the
 * dealer would counter and nobody would be told. Callers that can repeat an
 * action MUST pass one.
 */
export function eventKey(
  dealId: string,
  action: DealAction,
  offerVersion: number,
  discriminator?: string | number,
): string {
  const base = `${dealId}:${action}:${offerVersion}`;
  return discriminator === undefined ? base : `${base}:${discriminator}`;
}

/**
 * Reads the deal for a request and locks the row FOR UPDATE, so the status we
 * validate against cannot change under us mid-transaction. Every mutating route
 * starts here.
 */
export async function loadDealForUpdate(
  tx: BuybackTx,
  requestId: string,
): Promise<{ id: string; status: DealState; offer_version: number } | null> {
  const rows = await tx.execute(sql`
    SELECT id, status, offer_version
    FROM buyback_deals
    WHERE request_id = ${requestId}
    FOR UPDATE
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  return {
    id: String(row.id),
    status: row.status as DealState,
    offer_version: Number(row.offer_version),
  };
}
