/**
 * The vocabulary behind the admin "Notification Access" screen (E-231): every
 * dashboard that can be governed, and a human label for every notification type
 * that can be muted.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This module holds only the two things that
 * genuinely did not exist before: dashboard labels, and type labels. It DERIVES
 * the type list itself from `CATEGORY_BY_TYPE` (catalog.ts) and
 * `CATEGORY_BY_ACTION` (buyback/notification-meta.ts) rather than restating it,
 * and it derives grouping from `categorize()` and group ORDER from `CATEGORIES`.
 * So category order, category membership and the type list each have exactly one
 * definition in the codebase, and it is the pre-existing one. Adding a type to
 * the catalogue puts it on the admin screen automatically.
 *
 * THE GUARD. The price of deriving is that a new type arrives here unlabelled.
 * `assertRegistryComplete()` is called by the test suite and by
 * `scripts/verify-notification-registry.ts`; it names every unlabelled type
 * rather than letting one silently render as a bare `snake_case` string.
 * It is deliberately NOT called at import time — this module is imported by the
 * client bundle, and a throw there would white-screen the settings page over a
 * missing label. Loud in CI, forgiving at runtime.
 *
 * "SYSTEM" IS NARROWER HERE THAN IN THE BELL. `typeFilterForCategory("System")`
 * is a NEGATED filter — System there means "everything unmapped", present and
 * future. This screen cannot govern a type it has never heard of, so its System
 * group lists only the explicitly-mapped System types. An unregistered type is
 * simply always-on, which is the honest and safe answer (see the E-231 header on
 * why default-on is not negotiable).
 *
 * Pure and framework-free on purpose — no DB, no React. Both the API route and
 * the client import it.
 */

import {
  CATEGORIES,
  CATEGORY_BY_TYPE,
  categorize,
  type NotificationCategory,
} from "@/lib/notifications/catalog";
import { CATEGORY_BY_ACTION } from "@/lib/buyback/notification-meta";

// -----------------------------------------------------------------------------
// Dashboards
// -----------------------------------------------------------------------------
// The 17 canonical roles. The source of truth is `roleDashboards` in
// src/middleware.ts — `users.role` is free-text varchar with no enum, so there
// is no database object to read this from. The registry test hardcodes the same
// list so that changing either side is a deliberate two-file edit rather than a
// silent drift.
//
// `value` MUST equal what `users.role` holds, lowercased. See the E-231 CHECK.

export interface DashboardMeta {
  value: string;
  label: string;
  /** Rendered under the panel header when the mute is broader than it looks. */
  note?: string;
}

export const DASHBOARDS: DashboardMeta[] = [
  { value: "ceo", label: "CEO Dashboard" },
  { value: "business_head", label: "Business Head Dashboard" },
  { value: "sales_head", label: "Sales Head Dashboard" },
  { value: "sales_manager", label: "Sales Manager Dashboard" },
  { value: "asm", label: "ASM Dashboard" },
  { value: "sales_executive", label: "Sales Executive Dashboard" },
  { value: "inside_sales_rep", label: "Inside Sales Dashboard" },
  { value: "sales_insight", label: "Sales Insight Dashboard" },
  { value: "finance_controller", label: "Finance Controller Dashboard" },
  { value: "inventory_manager", label: "Inventory Manager Dashboard" },
  { value: "sales_order_manager", label: "Sales Order Manager Dashboard" },
  { value: "service_engineer", label: "Service Engineer Dashboard" },
  { value: "admin", label: "Admin Dashboard" },
  { value: "it", label: "IT Dashboard", note: "Security surface. Its own login; not reachable by admin or CEO." },
  {
    value: "dealer",
    label: "Dealer Portal",
    note: "External surface. Muting here changes what your dealers are told.",
  },
  {
    value: "nbfc_partner",
    label: "NBFC Partner Portal",
    note:
      "Covers EVERY NBFC tenant and every seat. The finer per-tenant role lives in nbfc_users.role, which this gate does not read — muting here silences the event for all partners at once.",
  },
  {
    value: "scrap_vendor",
    label: "Scrap Vendor Portal",
    note: "External surface. Muting here changes what your vendors are told.",
  },
];

const DASHBOARD_VALUES = new Set(DASHBOARDS.map((d) => d.value));

export function isKnownDashboard(value: string): boolean {
  return DASHBOARD_VALUES.has(value.trim().toLowerCase());
}

/**
 * Which dashboards a given CRM role may edit on this screen.
 *
 * admin / ceo get everything. sales_head gets its own reporting line plus the
 * CEO dashboard and the Dealer Portal.
 *
 * ON THE TWO ADDITIONS. They were deliberately excluded at first, on the
 * reasoning that a sales head should not be able to silence their own
 * supervisor's alerts, and that the external-facing portals carry contractual
 * weight — muting Dealer Portal changes what your dealers are told, not just
 * what your own team sees. Both were added back on request; the risk is
 * accepted, not overlooked. `admin`, `it`, `nbfc_partner` and `scrap_vendor`
 * remain out of scope.
 *
 * This rule lives here, once. The API applies it on BOTH read and write.
 */
const SALES_HEAD_SCOPE = [
  "ceo",
  "sales_head",
  "sales_manager",
  "asm",
  "sales_executive",
  "inside_sales_rep",
  "sales_insight",
  "dealer",
];

export function editableDashboardsFor(role: string | null | undefined): string[] {
  const r = (role ?? "").trim().toLowerCase();
  if (r === "admin" || r === "ceo") return DASHBOARDS.map((d) => d.value);
  if (r === "sales_head") return SALES_HEAD_SCOPE;
  return [];
}

// -----------------------------------------------------------------------------
// Type labels
// -----------------------------------------------------------------------------
// A human label for every key of CATEGORY_BY_TYPE, plus every
// `buyback.${action}` from CATEGORY_BY_ACTION.
//
// Both naming generations are present because both are live: new emitters use
// `<domain>.<event>`, and the legacy flat types (`kyc_rejected`,
// `loan_sanctioned`, `inventory_assigned`…) were in the table before the hub
// existed and are still written today. Where a dotted type and a flat type mean
// the same thing, the label says so — an admin looking at two rows that read
// identically will mute one and be surprised.

export const TYPE_LABELS: Record<string, string> = {
  // --- Leads ---
  "lead.created": "Lead created",
  "lead.assigned": "Lead assigned to someone",
  "lead.discarded": "Lead discarded",
  "lead.closed": "Lead closed",
  "lead.qualified": "Lead qualified",

  // --- Dealer onboarding ---
  "onboarding.chat_started": "Dealer started the WhatsApp onboarding chat",
  "onboarding.docs_uploaded": "Dealer uploaded onboarding documents",
  "onboarding.submitted": "Dealer submitted their onboarding application",
  "onboarding.agreement_initiated": "Dealer agreement sent for signature",
  "onboarding.agreement_signed": "Dealer agreement signed",
  "onboarding.approved": "Dealer onboarding approved",
  "onboarding.rejected": "Dealer onboarding rejected",
  "onboarding.correction_requested": "Corrections requested on a dealer application",
  dealer_onboarding_submitted: "Dealer application submitted (legacy)",
  onboarding_initiated: "Onboarding started from a converted lead",
  "vendor.registered": "Scrap vendor registered",

  // --- KYC & consent ---
  "kyc.submitted": "Customer KYC submitted",
  "kyc.verified": "Customer KYC verified",
  "kyc.rejected": "Customer KYC rejected",
  "kyc.docs_requested": "More KYC documents requested",
  "kyc.coborrower_requested": "Co-borrower requested",
  "kyc.docs_shared": "KYC documents shared",
  "kyc.final_decision": "Final KYC decision recorded",
  "consent.sent": "DPDP consent link sent",
  "consent.signed": "DPDP consent signed",
  "consent.verified": "DPDP consent verified",
  kyc_verification_submitted: "KYC submitted for verification (legacy)",
  kyc_docs_requested: "More KYC documents requested (legacy)",
  kyc_rejected: "A KYC card was rejected (legacy)",
  kyc_accepted: "A KYC card was accepted (legacy)",
  kyc_approved_final: "KYC approved — final decision (legacy)",
  kyc_rejected_final: "KYC rejected — final decision (legacy)",
  step_3_cleared: "Step 3 cleared",
  step_3_dealer_action_required: "Step 3 needs the dealer to act",

  // --- The NBFC / admin / dealer request loop ---
  nbfc_doc_request: "NBFC document request (legacy)",
  "nbfc.request_raised": "NBFC raised a document request",
  "nbfc.request_forwarded": "Admin forwarded an NBFC request to the dealer",
  "nbfc.request_pushed": "Request pushed back to the NBFC",
  "nbfc.request_declined": "NBFC request declined",
  "nbfc.doc_uploaded": "Dealer uploaded a document the NBFC asked for",
  // E-240 — the direct NBFC ⇄ dealer channel (no admin forward in between).
  "nbfc.doc_req_direct": "NBFC asked the dealer for a document directly",
  "nbfc.doc_req_reply": "Dealer answered the NBFC's direct request",
  "nbfc.doc_verified": "NBFC verified a document",
  "nbfc.doc_rejected": "NBFC rejected a document",
  "nbfc.verdict_raised": "NBFC raised a verdict",
  "nbfc.verdict_responded": "Verdict answered",
  nbfc_verdict_forwarded: "NBFC verdict forwarded to the dealer",
  // The flat predecessor of `nbfc.request_forwarded`. Its catalog entry landed
  // without a matching label, so verify:notifications has been failing on it
  // since; the two maps have to move together.
  nbfc_doc_request_forwarded: "Admin forwarded an NBFC request (legacy)",

  // --- Field investigation ---
  "fi.requested": "Field investigation requested",
  "fi.assigned": "Field investigation assigned to an agent",
  "fi.submitted": "Field investigation report submitted",
  "fi.reviewed": "Field investigation reviewed",
  "fi.reinspection": "Re-inspection ordered",

  // --- Video KYC ---
  "vkyc.initiated": "Video KYC link sent",
  "vkyc.captured": "Video KYC recording captured",
  "vkyc.approved": "Video KYC approved",
  "vkyc.rejected": "Video KYC rejected",

  // --- E-NACH ---
  "enach.registered": "E-NACH mandate registered",
  "enach.confirmed": "E-NACH mandate confirmed",
  "enach.failed": "E-NACH mandate failed",
  "enach.waived": "E-NACH requirement waived",

  // --- Loan agreement ---
  "agreement.initiated": "Loan agreement sent for signature",
  "agreement.signed": "Loan agreement signed",
  "agreement.recorded": "Loan agreement recorded",

  // --- Loan & sanction ---
  "loan.offer_submitted": "NBFC submitted a financing offer",
  // E-238_offer_negotiation added these two to the catalogue and to events.ts
  // but not here, which left `assertRegistryComplete` failing on a clean tree
  // and both rows rendering as raw snake_case on the Notification Access
  // screen — the exact gap the test at the top of __tests__/registry.test.ts
  // exists to catch. Labelled from the notifyOfferNegotiated /
  // notifyOfferFixed docblocks.
  "loan.offer_negotiated": "Dealer countered a financing offer",
  "loan.offer_fixed": "NBFC fixed its final terms",
  "loan.winner_selected": "Winning NBFC selected",
  "loan.not_selected": "NBFC was not selected",
  "loan.sanctioned": "Loan sanctioned",
  "loan.rejected": "Loan rejected",
  "loan.disbursed": "Loan disbursed",
  loan_sanctioned: "Loan sanctioned (legacy)",
  loan_rejected: "Loan rejected (legacy)",

  // --- Product selection, dispatch, delivery ---
  "product.submitted": "Product selection submitted",
  "product.approved": "Product selection approved",
  "product.rejected": "Product selection rejected",
  "product.docs_uploaded": "Product documents uploaded",
  "product.cash_sale": "Cash sale confirmed",
  "product.dispatched": "Order dispatched",
  "product.delivered": "Order delivered",
  product_selection_submitted: "Product selection submitted (legacy)",
  cash_sale_confirmed: "Cash sale confirmed (legacy)",
  dispatch_confirmed: "Order dispatched (legacy)",
  delivery_confirmed: "Order delivered (legacy)",

  // --- Inventory ---
  inventory_assigned: "Inventory assigned to a dealer",
  inventory_transfer_incoming: "Incoming inventory transfer",
  inventory_transfer_acknowledged: "Inventory transfer acknowledged",

  // --- Battery auctions (E-234) ---
  "auction.lot_published": "A battery lot went live for bidding",
  "auction.outbid": "You have been outbid on a lot",
  "auction.ending_soon": "A lot you bid on is ending within the hour",
  "auction.won": "You won a battery lot",
  "auction.lost": "A lot you bid on closed with someone else",

  // --- Escalations ---
  escalation_raised: "Escalation raised (legacy)",
  escalation_resolved: "Escalation resolved (legacy)",
  "escalation.raised": "Escalation raised",
  "escalation.resolved": "Escalation resolved",

  // --- System ---
  "nbfc.dual_approval": "Dual approval requested",
  "nbfc.wallet_low": "NBFC wallet balance is low",
  ops_alert: "Operations alert (no current emitter)",
  // E-230's price-register sweep. `oem.price_missing` predates its emitter —
  // 5 rows were already in the bell from something outside this repo when
  // verify:notifications first flagged it — but notifyOemPricesMissing() and
  // notifyOemPricesExpiring() are the producers now.
  "oem.price_missing": "Models with no OEM reference price",
  "oem.price_expiring": "OEM prices about to lapse",
  // E-242. Fires once a quotation clears the gate — by the CEO or by the OEM
  // price rule — and its draft has been generated.
  "quote.approved": "Quotation approved",
  // E-243. The dealer's own answer, captured from the approval link or a
  // tapped WhatsApp button.
  "quote.dealer_decision": "Dealer responded to a quotation",

  // --- Buyback: negotiation ---
  "buyback.negotiate": "Buyback price negotiation opened",
  "buyback.dealer_counter": "Dealer countered the buyback price",
  "buyback.admin_counter": "Admin countered the buyback price",
  "buyback.dealer_accept_counter": "Dealer accepted the counter-offer",
  "buyback.admin_accept_counter": "Admin accepted the counter-offer",
  "buyback.send_final_offer": "Final buyback offer sent",
  "buyback.dealer_accept": "Dealer accepted the buyback offer",
  "buyback.dealer_decline": "Dealer declined the buyback offer",

  // --- Buyback: request lifecycle ---
  "buyback.submit": "Buyback request submitted",
  "buyback.resubmit": "Buyback request resubmitted",
  "buyback.start_review": "Buyback request under review",
  "buyback.accept": "Buyback request accepted",
  "buyback.reject": "Buyback request rejected",
  "buyback.request_info": "More information requested on a buyback",
  "buyback.reopen": "Buyback request reopened",
  "buyback.cancel": "Buyback request cancelled",
  "buyback.close_deal": "Buyback deal closed",

  // --- Buyback: quotations ---
  "buyback.route_to_vendors": "Buyback routed to scrap vendors",
  "buyback.record_vendor_counter": "Vendor counter-quote recorded",
  "buyback.record_vendor_agreement": "Vendor agreement recorded",
  "buyback.vendor_counter": "Vendor countered the quote",
  "buyback.vendor_agree": "Vendor agreed to the quote",

  // --- Buyback: purchase orders ---
  "buyback.exchange_pos": "Purchase orders exchanged",
  "buyback.issue_dealer_po": "Dealer purchase order issued",
  "buyback.submit_vendor_po": "Vendor purchase order submitted",

  // --- Buyback: pickup ---
  "buyback.schedule_pickup": "Pickup scheduled",
  "buyback.complete_pickup": "Pickup completed",

  // --- Buyback: invoices ---
  "buyback.raise_invoice": "Invoice raised",
  "buyback.approve_invoice": "Invoice approved",
  "buyback.return_invoice": "Invoice returned for correction",

  // --- Buyback: payments ---
  "buyback.record_settlement": "Settlement recorded",
  "buyback.settle": "Buyback settled",
  "buyback.gateway_alert": "Payment gateway anomaly",
  "buyback.gateway_failed": "Payment failed at the gateway",
  "buyback.gateway_amount_mismatch": "Payment amount does not reconcile",
  "buyback.gateway_deadlink_paid": "Payment arrived on a dead payment link",
  "buyback.gateway_double_payment": "Duplicate payment detected",
  "buyback.gateway_reversed": "Payout was reversed",
  "buyback.gateway_partial_payment": "Partial payment arrived",
  "buyback.gateway_payout_initiated": "Payout initiated",
  "buyback.gateway_link_created": "Payment link created (gateway)",
  "buyback.payment_link_created": "Payment link created (settlement)",
  "buyback.vendor_payment_link": "Vendor payment link sent",

  // --- Buyback: system ---
  "buyback.set_margin": "Buyback margin changed",
  "buyback.price_review_due": "Buyback price review due",
  "buyback.duplicate_photo": "Duplicate battery photo detected",
  "buyback.agreement_signed": "Buyback agreement signed",
};

// -----------------------------------------------------------------------------
// Derivation
// -----------------------------------------------------------------------------

/** Every governable type string, derived from the two taxonomies. */
export function allGovernableTypes(): string[] {
  return [
    ...Object.keys(CATEGORY_BY_TYPE),
    ...Object.keys(CATEGORY_BY_ACTION).map((a) => `buyback.${a}`),
  ];
}

export function isKnownType(type: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(CATEGORY_BY_TYPE, type) ||
    (type.startsWith("buyback.") &&
      Object.prototype.hasOwnProperty.call(CATEGORY_BY_ACTION, type.slice("buyback.".length)))
  );
}

export interface TypeGroup {
  category: NotificationCategory;
  types: { value: string; label: string }[];
}

/**
 * The screen's body: types grouped by category, groups in the same order the
 * bell's own filter bar uses, types alphabetical by label inside a group.
 *
 * An unlabelled type still renders — falling back to its raw string — so a
 * missing label is a cosmetic bug in CI, never a notification that quietly
 * cannot be governed.
 */
export function typeGroups(): TypeGroup[] {
  const byCategory = new Map<NotificationCategory, { value: string; label: string }[]>();

  for (const value of allGovernableTypes()) {
    const category = categorize(value);
    const bucket = byCategory.get(category) ?? [];
    bucket.push({ value, label: TYPE_LABELS[value] ?? value });
    byCategory.set(category, bucket);
  }

  return CATEGORIES.filter((c) => byCategory.has(c)).map((category) => ({
    category,
    types: (byCategory.get(category) ?? []).sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

/**
 * Throws listing every problem. Called by the registry test and by
 * `npm run verify:notifications` — NOT at import time, because this module is in
 * the client bundle and a missing label must not white-screen the page.
 */
export function assertRegistryComplete(): void {
  const problems: string[] = [];

  const governable = allGovernableTypes();
  const missing = governable.filter((t) => !TYPE_LABELS[t]);
  if (missing.length) {
    problems.push(
      `${missing.length} notification type(s) have no label in TYPE_LABELS:\n  ${missing.join("\n  ")}`,
    );
  }

  const known = new Set(governable);
  const orphans = Object.keys(TYPE_LABELS).filter((t) => !known.has(t));
  if (orphans.length) {
    problems.push(
      `${orphans.length} label(s) name a type that no longer exists in the catalogue:\n  ${orphans.join("\n  ")}`,
    );
  }

  // notifications.type is varchar(50) and emit.ts safeType() truncates silently.
  // A 51-char type would be stored truncated, so it would be both mis-categorised
  // in the bell and ungovernable here — the row written would never match the
  // notification_access row this screen wrote.
  const tooLong = governable.filter((t) => t.length > 50);
  if (tooLong.length) {
    problems.push(
      `${tooLong.length} type(s) exceed notifications.type's varchar(50):\n  ${tooLong.join("\n  ")}`,
    );
  }

  const badDashboards = DASHBOARDS.filter((d) => d.value !== d.value.toLowerCase());
  if (badDashboards.length) {
    problems.push(
      `DASHBOARDS values must be lowercase (E-231 CHECK): ${badDashboards.map((d) => d.value).join(", ")}`,
    );
  }

  if (problems.length) {
    throw new Error(`notification registry is incomplete\n\n${problems.join("\n\n")}`);
  }
}
