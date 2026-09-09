/**
 * E-292 — the refurbishment LOT status machine, v3. Pure: no I/O, unit-tested.
 *
 * A lot is one batch of batteries the NBFC sends for refurbishment. Its status
 * tracks the CONVERSATION, the PAPER (PI), the MONEY and the TRUCK — not the
 * repair, which lives per battery on refurbishment_jobs.status.
 *
 *   requested          NBFC sent the batch; admin owes a review
 *   reviewed           admin checked each battery (declines applied); owes an estimate
 *   estimated          admin sent timeline + costing + advance %; NBFC owes accept / counter
 *   countered          NBFC pushed back (cost / timeline / advance); admin owes a re-estimate
 *   agreed             NBFC accepted the estimate; admin owes the proforma invoice
 *   pi_sent            PI (PDF, amount, advance %, bank details) is with the NBFC
 *   pi_accepted        NBFC accepted the PI. If it carries an advance the NBFC
 *                      owes it (records a UTR), then admin confirms; if not, the
 *                      batteries may move straight away
 *   advance_recorded   admin marked the advance "amount received"; batteries may move
 *   in_transit_out     on the road to iTarang (NBFC dispatched or iTarang picked up);
 *                      admin owes the per-battery receipt ("arrived" is a timestamp)
 *   received           signed for battery by battery; admin owes a refurbisher
 *   at_refurbisher     assigned to a refurbisher partner; the refurbisher owes "start work"
 *   in_progress        refurbisher working; owes a final cost per battery
 *   costed             every live battery costed; admin owes margin + final bill → NBFC,
 *                      then marks each battery ready
 *   ready              every open battery ready; admin / refurbisher owe the truck back
 *   in_transit_return  on the road to the NBFC; NBFC owes "arrived"
 *   delivered_back     at the NBFC's gate; NBFC owes the per-battery receipt
 *   balance_due        batteries back; NBFC owes final_total − advance
 *   settled            money done; NBFC owes the redeploy / auction choice
 *   closed             NBFC chose (close_outcome) — terminal
 *   cancelled          called off before anything moved — terminal
 *
 * NAMING NOTE. The EVENT kind `advance_recorded` means "the NBFC typed a UTR"
 * (advance_status = recorded); the lot STATUS `advance_recorded` means "admin
 * confirmed the money arrived" (advance_status = confirmed). The status label
 * reads "Advance received" for that reason.
 *
 * Cancellation is only legal while nothing has physically moved. Once the lot
 * is on a truck the batteries are in someone else's hands; per-battery
 * problems after that are handled on the job (damaged / missing at receipt).
 *
 * Gone since v2 (E-271): proposed, awaiting_advance, advance_paid,
 * pickup_scheduled, delivered, revision_pending, and the approved-quote gate.
 */

export const LOT_STATUSES = [
  "requested",
  "reviewed",
  "estimated",
  "countered",
  "agreed",
  "pi_sent",
  "pi_accepted",
  "advance_recorded",
  "in_transit_out",
  "received",
  "at_refurbisher",
  "in_progress",
  "costed",
  "ready",
  "in_transit_return",
  "delivered_back",
  "balance_due",
  "settled",
  "closed",
  "cancelled",
] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export type Party = "nbfc" | "admin" | "refurbisher";
export const PARTIES: Party[] = ["nbfc", "admin", "refurbisher"];
export type PickupMode = "nbfc_ships" | "itarang_pickup";
export const PICKUP_MODES: PickupMode[] = ["nbfc_ships", "itarang_pickup"];
export type CloseOutcome = "redeploy" | "auction";
export const CLOSE_OUTCOMES: CloseOutcome[] = ["redeploy", "auction"];

/** Terminal. `settled` is NOT closed — the NBFC still owes the redeploy / auction choice. */
export const CLOSED_LOT_STATUSES: LotStatus[] = ["closed", "cancelled"];
/** Live lots — what the lists show by default. */
export const OPEN_LOT_STATUSES: LotStatus[] = LOT_STATUSES.filter(
  (s) => !CLOSED_LOT_STATUSES.includes(s),
);
/** No more edits of any kind (photos, messages): the record is finished. */
export const FINISHED_LOT_STATUSES: LotStatus[] = ["settled", "closed", "cancelled"];

/** Nothing has moved yet: NBFC or admin may still cancel. */
export const CANCELLABLE_LOT_STATUSES: LotStatus[] = [
  "requested",
  "reviewed",
  "estimated",
  "countered",
  "agreed",
  "pi_sent",
  "pi_accepted",
  "advance_recorded",
];

/** Statuses from which the batteries may be put on a truck to iTarang — see shippableOut(). */
export const SHIPPABLE_OUT_STATUSES: LotStatus[] = ["pi_accepted", "advance_recorded"];

/** Statuses in which the batteries physically sit with the refurbisher. */
export const AT_REFURBISHER_STATUSES: LotStatus[] = ["at_refurbisher", "in_progress", "costed", "ready"];

export type LotMove =
  | "review"
  | "estimate"
  | "accept"
  | "counter"
  | "send_pi"
  | "accept_pi"
  | "advance_received"
  | "dispatch_out"
  | "pickup"
  | "receive_out"
  | "assign"
  | "start_work"
  | "all_costed"
  | "all_ready"
  | "dispatch_return"
  | "arrive_return"
  | "receive_return"
  | "settle"
  | "close"
  | "cancel";

export type MoveBy = Party[] | "system";

const EDGES: Record<LotMove, { from: LotStatus[]; to: LotStatus; by: MoveBy }> = {
  // re-entrant: admin may decline in two passes; an empty decision list is "mark reviewed"
  review: { from: ["requested", "reviewed"], to: "reviewed", by: ["admin"] },
  estimate: { from: ["reviewed", "countered"], to: "estimated", by: ["admin"] },
  accept: { from: ["estimated"], to: "agreed", by: ["nbfc"] },
  counter: { from: ["estimated"], to: "countered", by: ["nbfc"] },
  // re-entrant: a corrected PDF may replace the PI until the NBFC accepts it
  send_pi: { from: ["agreed", "pi_sent"], to: "pi_sent", by: ["admin"] },
  accept_pi: { from: ["pi_sent"], to: "pi_accepted", by: ["nbfc"] },
  advance_received: { from: ["pi_accepted"], to: "advance_recorded", by: ["admin"] },
  // both guarded by shippableOut() — pi_accepted only ships when no advance is due
  dispatch_out: { from: SHIPPABLE_OUT_STATUSES, to: "in_transit_out", by: ["nbfc"] },
  pickup: { from: SHIPPABLE_OUT_STATUSES, to: "in_transit_out", by: ["admin"] },
  // "mark arrived" on this leg is a timestamp + event only, not a state
  receive_out: { from: ["in_transit_out"], to: "received", by: ["admin"] },
  // re-entrant: re-assign until work starts
  assign: { from: ["received", "at_refurbisher"], to: "at_refurbisher", by: ["admin"] },
  start_work: { from: ["at_refurbisher"], to: "in_progress", by: ["refurbisher", "admin"] },
  all_costed: { from: ["in_progress"], to: "costed", by: "system" },
  all_ready: { from: ["costed"], to: "ready", by: "system" },
  dispatch_return: { from: ["ready"], to: "in_transit_return", by: ["admin", "refurbisher"] },
  arrive_return: { from: ["in_transit_return"], to: "delivered_back", by: ["nbfc"] },
  // delivered_back → balance_due | settled decided by nextAfterReceipt
  receive_return: { from: ["delivered_back"], to: "balance_due", by: ["nbfc"] },
  settle: { from: ["balance_due"], to: "settled", by: ["admin"] },
  close: { from: ["settled"], to: "closed", by: ["nbfc"] },
  cancel: { from: CANCELLABLE_LOT_STATUSES, to: "cancelled", by: ["nbfc", "admin"] },
};

export function isLotStatus(v: unknown): v is LotStatus {
  return typeof v === "string" && (LOT_STATUSES as readonly string[]).includes(v);
}

/** The status a lot lands on after `move`, or null when the move is illegal from `from`. */
export function nextLotStatus(from: string, move: LotMove): LotStatus | null {
  const edge = EDGES[move];
  if (!edge) return null;
  return (edge.from as readonly string[]).includes(from) ? edge.to : null;
}

/**
 * Throws `CONFLICT:` — which every route's statusFromError maps to 409 —
 * naming both the status and the move.
 */
export function assertLotMove(from: string, move: LotMove): LotStatus {
  const to = nextLotStatus(from, move);
  if (!to) {
    throw new Error(
      `CONFLICT: a lot that is ${LOT_STATUS_LABEL[from as LotStatus]?.toLowerCase() ?? from.replace(/_/g, " ")} cannot ${move.replace(/_/g, " ")}`,
    );
  }
  return to;
}

/** Who is allowed to perform `move`. */
export function moveParty(move: LotMove): MoveBy {
  return EDGES[move].by;
}

/** May `party` perform `move`? System moves are never performed by a party directly. */
export function partyMayMove(party: Party, move: LotMove): boolean {
  const by = EDGES[move].by;
  return by !== "system" && by.includes(party);
}

/**
 * The batteries may leave the NBFC only once the PI's money gate is satisfied:
 * either the advance was confirmed (advance_recorded), or the PI carried no
 * advance at all (pi_accepted + not_required). A pending or merely recorded
 * advance keeps the truck parked.
 */
export function shippableOut(lot: { status: string; advance_status?: string | null }): boolean {
  if (lot.status === "advance_recorded") return true;
  if (lot.status === "pi_accepted") return (lot.advance_status ?? "not_required") === "not_required";
  return false;
}

/**
 * After the NBFC signs for the returned batteries: is money still owed?
 * E-293: the balance may already be confirmed by then (it is paid BEFORE the
 * return truck) — a confirmed balance settles the lot on receipt.
 */
export function nextAfterReceipt(balanceAmount: number | null, balanceStatus?: string | null): LotStatus {
  if (balanceStatus === "confirmed") return "settled";
  return balanceAmount != null && balanceAmount > 0.005 ? "balance_due" : "settled";
}

/**
 * E-293: may the batteries ship back? The NBFC must have RECORDED the balance
 * (payment slip + bank reference) or iTarang must have CONFIRMED it; a lot
 * that owes nothing (`not_due`) is free to go.
 */
export function balanceClearedForReturn(lot: { balance_status?: string | null }): boolean {
  const s = lot.balance_status ?? "not_due";
  return s === "not_due" || s === "recorded" || s === "confirmed";
}

export interface AwaitingContext {
  advance_status?: string | null;
  balance_status?: string | null;
  pickup_mode?: string | null;
  final_sent_at?: string | Date | null;
}

/**
 * Which party owes the next move. Money legs depend on the sub-status: the
 * NBFC owes an unpaid advance, iTarang owes the confirmation once recorded.
 * From the NBFC's viewpoint the refurbisher IS iTarang — the UI maps it.
 */
export function awaitingParty(status: string, ctx: AwaitingContext = {}): Party | null {
  switch (status as LotStatus) {
    case "requested":
    case "reviewed":
    case "countered":
    case "agreed":
    case "in_transit_out":
    case "received":
      return "admin";
    case "ready": {
      // E-293: the balance is paid before the truck. Pending → the NBFC owes
      // the slip + UTR; recorded → iTarang confirms (and may dispatch).
      const bal = ctx.balance_status ?? "not_due";
      return bal === "pending" ? "nbfc" : "admin";
    }
    case "estimated":
    case "pi_sent":
    case "in_transit_return":
    case "delivered_back":
    case "settled":
      return "nbfc";
    case "at_refurbisher":
    case "in_progress":
      return "refurbisher";
    case "costed":
      return "admin"; // set margin, then mark ready
    case "pi_accepted": {
      const adv = ctx.advance_status ?? "not_required";
      if (adv === "recorded") return "admin"; // confirm the UTR
      if (adv === "pending") return "nbfc"; // pay + record
      // not_required: whoever moves the batteries
      return ctx.pickup_mode === "itarang_pickup" ? "admin" : "nbfc";
    }
    case "advance_recorded":
      return ctx.pickup_mode === "itarang_pickup" ? "admin" : "nbfc";
    case "balance_due":
      return ctx.balance_status === "recorded" ? "admin" : "nbfc";
    default:
      return null; // closed, cancelled
  }
}

export const LOT_STATUS_LABEL: Record<LotStatus, string> = {
  requested: "Requested",
  reviewed: "Reviewed",
  estimated: "Estimate sent",
  countered: "Changes requested",
  agreed: "Agreed",
  pi_sent: "PI sent",
  pi_accepted: "PI accepted",
  advance_recorded: "Advance received",
  in_transit_out: "In transit to iTarang",
  received: "Received at iTarang",
  at_refurbisher: "At refurbisher",
  in_progress: "Work in progress",
  costed: "Costed",
  ready: "Ready to return",
  in_transit_return: "In transit to NBFC",
  delivered_back: "Arrived at NBFC",
  balance_due: "Balance due",
  settled: "Settled",
  closed: "Closed",
  cancelled: "Cancelled",
};

/**
 * Given the job statuses of a lot, is every live battery now `ready` (or
 * already returned)? Declined / cancelled jobs left the lot. Empty = not ready.
 */
export function allOpenItemsReady(jobStatuses: string[]): boolean {
  const live = jobStatuses.filter((s) => s !== "declined" && s !== "cancelled");
  return live.length > 0 && live.every((s) => s === "ready" || s === "returned");
}

/** Every live job carries a refurbisher cost. Empty = not costed. */
export function allOpenItemsCosted(jobs: Array<{ status: string; costed_at?: unknown }>): boolean {
  const live = jobs.filter((j) => j.status !== "declined" && j.status !== "cancelled");
  return live.length > 0 && live.every((j) => !!j.costed_at);
}

/**
 * Split the iTarang margin across the live batteries pro-rata to their
 * refurbisher cost (+ accessories), in paise, so the per-battery final costs
 * sum EXACTLY to the lot's final total — the last battery absorbs rounding.
 * A zero-cost lot splits the margin evenly.
 */
export function splitMargin(bases: number[], margin: number): number[] {
  if (bases.length === 0) return [];
  const total = bases.reduce((s, b) => s + b, 0);
  const marginP = Math.round(margin * 100);
  const shares: number[] = [];
  let used = 0;
  for (let i = 0; i < bases.length; i++) {
    const last = i === bases.length - 1;
    const share = last
      ? marginP - used
      : Math.round(total > 0 ? (marginP * bases[i]) / total : marginP / bases.length);
    shares.push(share);
    used += share;
  }
  return shares.map((p, i) => Math.round(bases[i] * 100 + p) / 100);
}

// ---------------------------------------------------------------------------
// Custody — where a battery physically is
// ---------------------------------------------------------------------------
export const CUSTODY = [
  "with_nbfc",
  "awaiting_pickup",
  "in_transit_to_itarang",
  "at_itarang",
  "at_refurbisher",
  "in_transit_to_nbfc",
  "at_nbfc_gate",
  "back_with_nbfc",
  "unknown_lost",
] as const;
export type Custody = (typeof CUSTODY)[number];

export const CUSTODY_LABEL: Record<Custody, string> = {
  with_nbfc: "With NBFC",
  awaiting_pickup: "With NBFC — awaiting pickup",
  in_transit_to_itarang: "In transit to iTarang",
  at_itarang: "At iTarang",
  at_refurbisher: "At refurbisher",
  in_transit_to_nbfc: "In transit to NBFC",
  at_nbfc_gate: "At NBFC gate (not yet checked)",
  back_with_nbfc: "Back with NBFC",
  unknown_lost: "Missing — not received",
};

/**
 * Derived, never stored: the lot's status says where the truck is, the job's
 * status and receipt conditions say whether THIS battery was on it.
 */
export function custodyForItem(
  lot: { status: string; advance_status?: string | null; pickup_mode?: string | null },
  job: { status: string; out_received_condition?: string | null; ret_received_condition?: string | null },
): Custody {
  if (job.status === "declined" || job.status === "cancelled") {
    // A job cancelled because the battery never arrived is the one exception.
    return job.out_received_condition === "missing" ? "unknown_lost" : "with_nbfc";
  }
  if (job.status === "returned") return "back_with_nbfc";
  switch (lot.status as LotStatus) {
    case "requested":
    case "reviewed":
    case "estimated":
    case "countered":
    case "agreed":
    case "pi_sent":
    case "cancelled":
      return "with_nbfc";
    case "pi_accepted":
    case "advance_recorded":
      return shippableOut(lot) && lot.pickup_mode === "itarang_pickup" ? "awaiting_pickup" : "with_nbfc";
    case "in_transit_out":
      return "in_transit_to_itarang";
    case "received":
      return job.out_received_condition === "missing" ? "unknown_lost" : "at_itarang";
    case "at_refurbisher":
    case "in_progress":
    case "costed":
    case "ready":
      return job.out_received_condition === "missing" ? "unknown_lost" : "at_refurbisher";
    case "in_transit_return":
      return "in_transit_to_nbfc";
    case "delivered_back":
      return "at_nbfc_gate";
    case "balance_due":
    case "settled":
    case "closed":
      return job.ret_received_condition === "missing" ? "unknown_lost" : "back_with_nbfc";
    default:
      return "with_nbfc";
  }
}

export const RECEIPT_CONDITIONS = ["received", "damaged", "missing"] as const;
export type ReceiptCondition = (typeof RECEIPT_CONDITIONS)[number];

export const EVENT_KINDS = [
  "requested",
  "item_declined",
  "reviewed",
  "estimated",
  "countered",
  "accepted",
  "cancelled",
  "pi_sent",
  "pi_accepted",
  "advance_recorded",
  "advance_confirmed",
  "dispatched_out",
  "picked_up",
  "arrived_out",
  "received_out",
  "refurbisher_assigned",
  "work_started",
  "item_costed",
  "all_costed",
  "final_bill_sent",
  "item_ready",
  "dispatched_return",
  "arrived_return",
  "received_return",
  "balance_recorded",
  // E-293: balance marked received while the batteries are still with the
  // refurbisher (settlement happens at receipt); `settled` when they are back.
  "balance_confirmed",
  "settled",
  "closed",
  "message",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** v2 kinds still present on old timeline rows — rendered, never emitted. */
export const LEGACY_EVENT_KINDS = [
  "proposed",
  "pickup_scheduled",
  "revision_proposed",
  "revision_approved",
  "revision_rejected",
] as const;
