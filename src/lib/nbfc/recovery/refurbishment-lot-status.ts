/**
 * E-270 / E-271 — the refurbishment LOT status machine. Pure: no I/O, unit-tested.
 *
 * A lot is one batch of batteries the NBFC sends to the iTarang workshop. Its
 * status tracks the CONVERSATION, the MONEY and the TRUCK — not the repair,
 * which lives per battery on refurbishment_jobs.status.
 *
 *   requested          NBFC sent the batch; admin owes a review + quote
 *   proposed           admin quoted (timeline, pickup plan, estimate, advance);
 *                      NBFC owes an approval or a counter
 *   countered          NBFC pushed back; admin owes a new quote
 *   agreed             NBFC approved the quote (quote_approved_* frozen)
 *   awaiting_advance   quote carried an advance; NBFC owes it, then admin confirms
 *   advance_paid       advance confirmed
 *   pickup_scheduled   iTarang collects on scheduled_pickup_date; admin owes pickup
 *   in_transit_out     on the road to the workshop (NBFC dispatched, or iTarang
 *                      picked up); admin owes "arrived"
 *   delivered          at the workshop gate; admin owes the per-battery receipt
 *   received           signed for battery by battery; admin owes work
 *   in_progress        workshop working; admin owes per-battery "ready"
 *   revision_pending   actuals exceed the approved quote; NBFC owes approve/reject
 *   ready              every open battery repaired within the approved quote;
 *                      admin owes the truck back
 *   in_transit_return  on the road to the NBFC; NBFC owes "arrived"
 *   delivered_back     at the NBFC's gate; NBFC owes the per-battery receipt
 *   balance_due        batteries back; NBFC owes final_total − advance
 *   settled            done — terminal
 *   cancelled          called off before anything moved — terminal
 *
 * Cancellation is only legal while nothing has physically moved. Once the lot
 * is on a truck the batteries are in someone else's hands. Per-battery
 * problems after that point are handled on the job (damaged / missing at
 * receipt, a job cancelled by admin).
 */

export const LOT_STATUSES = [
  "requested",
  "proposed",
  "countered",
  "agreed",
  "awaiting_advance",
  "advance_paid",
  "pickup_scheduled",
  "in_transit_out",
  "delivered",
  "received",
  "in_progress",
  "revision_pending",
  "ready",
  "in_transit_return",
  "delivered_back",
  "balance_due",
  "settled",
  "cancelled",
] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export type Party = "nbfc" | "admin";
export type PickupMode = "nbfc_ships" | "itarang_pickup";
export const PICKUP_MODES: PickupMode[] = ["nbfc_ships", "itarang_pickup"];

export const CLOSED_LOT_STATUSES: LotStatus[] = ["settled", "cancelled"];
/** Live lots — what the lists show by default. */
export const OPEN_LOT_STATUSES: LotStatus[] = LOT_STATUSES.filter(
  (s) => !CLOSED_LOT_STATUSES.includes(s),
);

/** Nothing has moved yet: either party may still cancel. */
export const CANCELLABLE_LOT_STATUSES: LotStatus[] = [
  "requested",
  "proposed",
  "countered",
  "agreed",
  "awaiting_advance",
  "advance_paid",
  "pickup_scheduled",
];

/** Statuses from which the batteries may be put on a truck to the workshop. */
export const SHIPPABLE_OUT_STATUSES: LotStatus[] = ["agreed", "advance_paid"];

export type LotMove =
  | "propose"
  | "accept"
  | "counter"
  | "cancel"
  | "advance_paid"
  | "schedule_pickup"
  | "dispatch_out"
  | "pickup"
  | "arrive_out"
  | "receive_out"
  | "start_work"
  | "revise"
  | "approve_revision"
  | "reject_revision"
  | "all_ready"
  | "dispatch_return"
  | "arrive_return"
  | "receive_return"
  | "settle";

const EDGES: Record<LotMove, { from: LotStatus[]; to: LotStatus; by: Party | "system" | "either" }> = {
  propose: { from: ["requested", "countered"], to: "proposed", by: "admin" },
  accept: { from: ["proposed"], to: "agreed", by: "nbfc" },
  counter: { from: ["proposed"], to: "countered", by: "nbfc" },
  cancel: { from: CANCELLABLE_LOT_STATUSES, to: "cancelled", by: "either" },
  // agreed → awaiting_advance happens inside `accept` when advance_pct > 0
  // (see nextAfterAgreed); this edge is admin confirming the money arrived.
  advance_paid: { from: ["awaiting_advance"], to: "advance_paid", by: "admin" },
  schedule_pickup: { from: ["agreed", "advance_paid"], to: "pickup_scheduled", by: "system" },
  dispatch_out: { from: SHIPPABLE_OUT_STATUSES, to: "in_transit_out", by: "nbfc" },
  pickup: { from: ["pickup_scheduled"], to: "in_transit_out", by: "admin" },
  arrive_out: { from: ["in_transit_out"], to: "delivered", by: "admin" },
  receive_out: { from: ["delivered"], to: "received", by: "admin" },
  start_work: { from: ["received"], to: "in_progress", by: "admin" },
  revise: { from: ["in_progress"], to: "revision_pending", by: "admin" },
  approve_revision: { from: ["revision_pending"], to: "in_progress", by: "nbfc" },
  reject_revision: { from: ["revision_pending"], to: "in_progress", by: "nbfc" },
  all_ready: { from: ["in_progress"], to: "ready", by: "system" },
  dispatch_return: { from: ["ready"], to: "in_transit_return", by: "admin" },
  arrive_return: { from: ["in_transit_return"], to: "delivered_back", by: "nbfc" },
  // delivered_back → balance_due | settled decided by nextAfterReceipt
  receive_return: { from: ["delivered_back"], to: "balance_due", by: "nbfc" },
  settle: { from: ["balance_due"], to: "settled", by: "admin" },
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
export function moveParty(move: LotMove): Party | "system" | "either" {
  return EDGES[move].by;
}

/**
 * After the NBFC approves the quote: does money or a pickup gate the truck?
 *   advance_pct > 0            → awaiting_advance (then advance_paid → pickup?)
 *   itarang_pickup             → pickup_scheduled
 *   otherwise                  → agreed (NBFC ships when ready)
 */
export function nextAfterAgreed(lot: { advance_pct: number; pickup_mode: string }): LotStatus {
  if (lot.advance_pct > 0) return "awaiting_advance";
  return lot.pickup_mode === "itarang_pickup" ? "pickup_scheduled" : "agreed";
}

/** After the advance is confirmed: straight to the pickup queue, or wait for the NBFC's truck. */
export function nextAfterAdvance(lot: { pickup_mode: string }): LotStatus {
  return lot.pickup_mode === "itarang_pickup" ? "pickup_scheduled" : "advance_paid";
}

/** After the NBFC signs for the returned batteries: is money still owed? */
export function nextAfterReceipt(balanceAmount: number | null): LotStatus {
  return balanceAmount != null && balanceAmount > 0.005 ? "balance_due" : "settled";
}

/**
 * Which party owes the next move. Money legs depend on the sub-status: the
 * NBFC owes an unpaid advance, iTarang owes the confirmation once recorded.
 */
export function awaitingParty(
  status: string,
  money?: { advance_status?: string | null; balance_status?: string | null },
): Party | null {
  switch (status as LotStatus) {
    case "requested":
    case "countered":
    case "pickup_scheduled":
    case "in_transit_out":
    case "delivered":
    case "received":
    case "in_progress":
    case "ready":
      return "admin";
    case "proposed":
    case "agreed":
    case "advance_paid":
    case "revision_pending":
    case "in_transit_return":
    case "delivered_back":
      return "nbfc";
    case "awaiting_advance":
      return money?.advance_status === "recorded" ? "admin" : "nbfc";
    case "balance_due":
      return money?.balance_status === "recorded" ? "admin" : "nbfc";
    default:
      return null;
  }
}

export const LOT_STATUS_LABEL: Record<LotStatus, string> = {
  requested: "Requested",
  proposed: "Quote sent",
  countered: "Changes requested",
  agreed: "Quote approved",
  awaiting_advance: "Advance due",
  advance_paid: "Advance paid",
  pickup_scheduled: "Pickup scheduled",
  in_transit_out: "In transit to workshop",
  delivered: "Arrived at workshop",
  received: "Received at workshop",
  in_progress: "Work in progress",
  revision_pending: "Revised quote pending",
  ready: "Ready to return",
  in_transit_return: "In transit to NBFC",
  delivered_back: "Arrived at NBFC",
  balance_due: "Balance due",
  settled: "Settled",
  cancelled: "Cancelled",
};

/**
 * Given the job statuses of a lot in `in_progress`, is every live battery now
 * `ready`? Declined / cancelled jobs left the lot. Empty = not ready.
 */
export function allOpenItemsReady(jobStatuses: string[]): boolean {
  const live = jobStatuses.filter((s) => s !== "declined" && s !== "cancelled");
  return live.length > 0 && live.every((s) => s === "ready" || s === "returned");
}

/**
 * The approved-quote gate (review point 2/5): the lot may only become `ready`
 * — and therefore ship back — while the actual bill is within what the NBFC
 * approved. Exceeding it means a revision round.
 */
export function withinApprovedQuote(actualTotal: number | null, approvedTotal: number | null): boolean {
  if (approvedTotal == null) return true; // legacy lots without a frozen quote
  return (actualTotal ?? 0) <= approvedTotal + 0.005;
}

// ---------------------------------------------------------------------------
// Custody — where a battery physically is (review point 4)
// ---------------------------------------------------------------------------
export const CUSTODY = [
  "at_nbfc",
  "awaiting_pickup",
  "in_transit_to_workshop",
  "at_workshop_gate",
  "at_workshop",
  "in_transit_to_nbfc",
  "at_nbfc_gate",
  "back_at_nbfc",
  "unknown_lost",
] as const;
export type Custody = (typeof CUSTODY)[number];

export const CUSTODY_LABEL: Record<Custody, string> = {
  at_nbfc: "With NBFC",
  awaiting_pickup: "With NBFC — awaiting pickup",
  in_transit_to_workshop: "In transit to workshop",
  at_workshop_gate: "At workshop gate (not yet checked)",
  at_workshop: "At iTarang workshop",
  in_transit_to_nbfc: "In transit to NBFC",
  at_nbfc_gate: "At NBFC gate (not yet checked)",
  back_at_nbfc: "Back with NBFC",
  unknown_lost: "Missing — not received",
};

/**
 * Derived, never stored: the lot's status says where the truck is, the job's
 * status and receipt conditions say whether THIS battery was on it.
 */
export function custodyForItem(
  lotStatus: string,
  job: { status: string; out_received_condition?: string | null; ret_received_condition?: string | null },
): Custody {
  if (job.status === "declined" || job.status === "cancelled") {
    // A job cancelled because the battery never arrived is the one exception.
    return job.out_received_condition === "missing" ? "unknown_lost" : "at_nbfc";
  }
  if (job.status === "returned") return "back_at_nbfc";
  switch (lotStatus as LotStatus) {
    case "requested":
    case "proposed":
    case "countered":
    case "agreed":
    case "awaiting_advance":
    case "advance_paid":
    case "cancelled":
      return "at_nbfc";
    case "pickup_scheduled":
      return "awaiting_pickup";
    case "in_transit_out":
      return "in_transit_to_workshop";
    case "delivered":
      return "at_workshop_gate";
    case "received":
    case "in_progress":
    case "revision_pending":
    case "ready":
      return job.out_received_condition === "missing" ? "unknown_lost" : "at_workshop";
    case "in_transit_return":
      return "in_transit_to_nbfc";
    case "delivered_back":
      return "at_nbfc_gate";
    case "balance_due":
    case "settled":
      return job.ret_received_condition === "missing" ? "unknown_lost" : "back_at_nbfc";
    default:
      return "at_nbfc";
  }
}

export const RECEIPT_CONDITIONS = ["received", "damaged", "missing"] as const;
export type ReceiptCondition = (typeof RECEIPT_CONDITIONS)[number];

export const EVENT_KINDS = [
  "requested",
  "item_declined",
  "proposed",
  "countered",
  "accepted",
  "cancelled",
  "advance_recorded",
  "advance_confirmed",
  "pickup_scheduled",
  "dispatched_out",
  "picked_up",
  "arrived_out",
  "received_out",
  "work_started",
  "revision_proposed",
  "revision_approved",
  "revision_rejected",
  "item_ready",
  "dispatched_return",
  "arrived_return",
  "received_return",
  "balance_recorded",
  "settled",
  "message",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
