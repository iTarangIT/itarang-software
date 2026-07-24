/**
 * Buyback notification taxonomy — the ONE place that maps a stored
 * `notifications.type` (always `buyback.<event_type>` for this module) to the
 * category, priority, and deep-link the notification centre renders.
 *
 * Pure and framework-free on purpose: the API route imports it to enrich each
 * row server-side, and the client imports the category list for its filter bar.
 * No DB, no React, no Tailwind — keep it that way so both sides can share it.
 *
 * WHY DERIVE INSTEAD OF STORING A COLUMN. `type` already encodes the event, so
 * category and priority are a pure function of it. Deriving avoids a migration
 * and a backfill of the ~460 existing buyback rows, and a newly-added event type
 * gets a sensible category the moment it exists (System, until it's mapped)
 * rather than needing a column populated everywhere first.
 */

export type NotificationCategory =
  | "Negotiation"
  | "Buyback Requests"
  | "Quotations"
  | "Purchase Orders"
  | "Invoices"
  | "Payments"
  | "Pickup"
  | "System";

export type NotificationPriority = "Info" | "Warning" | "Critical";

/**
 * "nbfc" was added when the bell was generalised CRM-wide: the NBFC partner
 * portal now runs the same shared bell as every other portal, so this type is
 * the role vocabulary for ALL notifications, not just buyback's. Buyback itself
 * never addresses an NBFC — see `linkFor` for what that role resolves to.
 */
export type NotificationRole = "dealer" | "admin" | "vendor" | "nbfc";

/** Ordered exactly as the filter bar should list them. */
export const CATEGORIES: NotificationCategory[] = [
  "Negotiation",
  "Buyback Requests",
  "Quotations",
  "Purchase Orders",
  "Invoices",
  "Payments",
  "Pickup",
  "System",
];

/**
 * action (the `buyback.` prefix stripped) → category.
 *
 * The action set is the buyback state-machine's DealAction plus a handful of
 * non-transition events that also land in the bell: `gateway_*` (money-gateway
 * anomalies), `price_review_due`, `duplicate_photo`, `agreement_signed`.
 */
const CATEGORY_BY_ACTION: Record<string, NotificationCategory> = {
  // Dealer ↔ admin price negotiation
  negotiate: "Negotiation",
  dealer_counter: "Negotiation",
  admin_counter: "Negotiation",
  dealer_accept_counter: "Negotiation",
  admin_accept_counter: "Negotiation",
  send_final_offer: "Negotiation",
  dealer_accept: "Negotiation",
  dealer_decline: "Negotiation",

  // Request lifecycle
  submit: "Buyback Requests",
  resubmit: "Buyback Requests",
  start_review: "Buyback Requests",
  accept: "Buyback Requests",
  reject: "Buyback Requests",
  request_info: "Buyback Requests",
  reopen: "Buyback Requests",
  cancel: "Buyback Requests",
  close_deal: "Buyback Requests",

  // Admin ↔ vendor quotation leg
  route_to_vendors: "Quotations",
  record_vendor_counter: "Quotations",
  record_vendor_agreement: "Quotations",
  vendor_counter: "Quotations",
  vendor_agree: "Quotations",

  // Purchase orders
  exchange_pos: "Purchase Orders",
  issue_dealer_po: "Purchase Orders",
  submit_vendor_po: "Purchase Orders",

  // Pickup / fulfilment
  schedule_pickup: "Pickup",
  complete_pickup: "Pickup",

  // Invoices
  raise_invoice: "Invoices",
  approve_invoice: "Invoices",
  return_invoice: "Invoices",

  // Money movement
  record_settlement: "Payments",
  settle: "Payments",
  gateway_alert: "Payments",
  gateway_payout_initiated: "Payments",
  gateway_link_created: "Payments",
  vendor_payment_link: "Payments",

  // Internal / system
  set_margin: "System",
  price_review_due: "System",
  duplicate_photo: "System",
  agreement_signed: "System",
};

/** Things that went wrong or need a decision — surfaced red. */
const CRITICAL = new Set([
  "reject",
  "return_invoice",
  "cancel",
  "gateway_alert",
  "duplicate_photo",
]);

/** Something is waiting on the recipient to act — surfaced amber. */
const WARNING = new Set([
  "request_info",
  "send_final_offer",
  "reopen",
  "dealer_decline",
  "price_review_due",
]);

/** Strip the `buyback.` prefix a stored type carries; tolerate a bare action. */
function actionOf(type: string): string {
  return type.startsWith("buyback.") ? type.slice("buyback.".length) : type;
}

export function categorize(type: string): NotificationCategory {
  return CATEGORY_BY_ACTION[actionOf(type)] ?? "System";
}

export function priorityOf(type: string): NotificationPriority {
  const a = actionOf(type);
  if (CRITICAL.has(a)) return "Critical";
  if (WARNING.has(a)) return "Warning";
  return "Info";
}

/**
 * A SQL-friendly filter for one category. Category is DERIVED from `type`, not
 * stored, so filtering the feed by category means filtering by the set of stored
 * `type`s that map to it. `System` is the catch-all — it also owns any type not
 * in the map — so it is expressed as NOT IN (every non-System type) rather than
 * an explicit list, which keeps a future unmapped event type showing up there.
 */
export function typeFilterForCategory(
  category: NotificationCategory,
): { types: string[]; negate: boolean } {
  if (category === "System") {
    const nonSystem = Object.entries(CATEGORY_BY_ACTION)
      .filter(([, c]) => c !== "System")
      .map(([action]) => `buyback.${action}`);
    return { types: nonSystem, negate: true };
  }
  const types = Object.entries(CATEGORY_BY_ACTION)
    .filter(([, c]) => c === category)
    .map(([action]) => `buyback.${action}`);
  return { types, negate: false };
}

export interface NotificationLinkData {
  request_id?: string | null;
  [k: string]: unknown;
}

/**
 * Where a notification points, per recipient role + category.
 *
 * Dealers and admins open the request in place (or its dedicated Payments /
 * Pickup / Negotiations page); vendors have no per-request page, so they route
 * to the relevant list surface instead. Returns null only when there is
 * genuinely nothing to open.
 */
export function linkFor(
  role: NotificationRole,
  category: NotificationCategory,
  data: NotificationLinkData | null | undefined,
): string | null {
  const requestId = data?.request_id ? String(data.request_id) : null;

  // An NBFC partner has no buyback surface at all — not /admin/buyback (no
  // access) and not /dealer-portal/buyback (not their portal). Returning null
  // renders the row as "nothing to open", which is the honest answer; sending
  // them to a page that 403s would be worse. Buyback never addresses an NBFC,
  // so this only guards a dual-role login.
  if (role === "nbfc") return null;

  if (role === "vendor") {
    switch (category) {
      case "Payments":
        return "/vendor-portal/payments";
      case "Purchase Orders":
      case "Invoices":
        return "/vendor-portal/orders";
      case "Quotations":
      case "Negotiation":
        return "/vendor-portal/bids";
      case "Buyback Requests":
        return "/vendor-portal/inbox";
      default:
        return "/vendor-portal";
    }
  }

  const isAdmin = role === "admin";

  // Category surfaces that live on their own page for dealer/admin.
  if (category === "Payments") {
    return isAdmin ? "/admin/buyback/payments" : "/dealer-portal/buyback/payments";
  }
  if (category === "Pickup" && !isAdmin) return "/dealer-portal/buyback/pickups";
  if (category === "Negotiation" && isAdmin) return "/admin/buyback/negotiations";

  // Everything else opens the request itself, falling back to the list.
  const base = isAdmin ? "/admin/buyback" : "/dealer-portal/buyback";
  return requestId ? `${base}/${requestId}` : base;
}
