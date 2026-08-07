/**
 * CRM-wide notification taxonomy — the ONE place that maps a stored
 * `notifications.type` to its category, priority, whether it deserves an email,
 * and (as a fallback) the page it opens for a given portal role.
 *
 * Sibling of `@/lib/buyback/notification-meta`, which owns the same three
 * questions for `buyback.*` types only. This module DELEGATES every buyback type
 * to that module rather than restating it — one taxonomy per domain, no second
 * copy to drift. Everything non-buyback is mapped here.
 *
 * WHY DERIVE INSTEAD OF STORING COLUMNS (same reasoning as notification-meta):
 * `type` already encodes the event, so category/priority/email are pure
 * functions of it. Deriving avoids a migration and a backfill of the ~1000
 * existing rows, and a newly-added type gets a sensible default (System, in-app
 * only) the moment it exists.
 *
 * WHY linkFor IS ONLY A FALLBACK. `emit()` writes a per-recipient `data.href`,
 * because one event lands in three portals on three different pages. The bell
 * prefers that href. linkFor exists for rows written before this module (and for
 * any emitter that forgets), so the bell is never a dead click.
 *
 * Pure and framework-free on purpose — no DB, no React. Both the API route and
 * the client import it.
 */

import {
  CATEGORIES as BUYBACK_CATEGORIES,
  categorize as buybackCategorize,
  linkFor as buybackLinkFor,
  priorityOf as buybackPriorityOf,
  typeFilterForCategory as buybackTypeFilter,
  type NotificationCategory as BuybackCategory,
  type NotificationPriority,
  type NotificationRole,
} from "@/lib/buyback/notification-meta";

export type { NotificationPriority, NotificationRole };

export type NotificationCategory =
  | BuybackCategory
  | "Leads"
  | "KYC & Consent"
  | "NBFC Requests"
  | "Loan & Sanction"
  | "Field Investigation"
  | "Video KYC"
  | "E-NACH"
  | "Agreements"
  | "Product & Dispatch"
  | "Onboarding"
  | "Inventory"
  | "Escalations";

/** Ordered exactly as the filter bar should list them. "System" stays last. */
export const CATEGORIES: NotificationCategory[] = [
  "Leads",
  "Onboarding",
  "KYC & Consent",
  "NBFC Requests",
  "Field Investigation",
  "Video KYC",
  "E-NACH",
  "Agreements",
  "Loan & Sanction",
  "Product & Dispatch",
  "Inventory",
  "Escalations",
  // Buyback's own categories, minus the "System" catch-all it shares with us.
  ...BUYBACK_CATEGORIES.filter((c) => c !== "System"),
  "System",
];

const isBuyback = (type: string) => type.startsWith("buyback.");

/**
 * type → category for everything that is not `buyback.*`.
 *
 * Both naming generations are listed on purpose. New emitters use
 * `<domain>.<event>`; the legacy flat types (`kyc_rejected`, `loan_sanctioned`,
 * …) were already in the table before this module existed and are mapped so no
 * backfill is needed. NOTE `notifications.type` is varchar(50) — keep new type
 * strings under 50 characters.
 */
const CATEGORY_BY_TYPE: Record<string, NotificationCategory> = {
  // --- Leads ---
  "lead.created": "Leads",
  "lead.assigned": "Leads",
  "lead.discarded": "Leads",
  "lead.closed": "Leads",
  "lead.qualified": "Leads",

  // --- Dealer onboarding (portal + WhatsApp) ---
  "onboarding.chat_started": "Onboarding",
  "onboarding.docs_uploaded": "Onboarding",
  "onboarding.submitted": "Onboarding",
  "onboarding.agreement_initiated": "Onboarding",
  "onboarding.agreement_signed": "Onboarding",
  "onboarding.approved": "Onboarding",
  "onboarding.rejected": "Onboarding",
  "onboarding.correction_requested": "Onboarding",
  dealer_onboarding_submitted: "Onboarding",

  // --- KYC & consent ---
  "kyc.submitted": "KYC & Consent",
  "kyc.verified": "KYC & Consent",
  "kyc.rejected": "KYC & Consent",
  "kyc.docs_requested": "KYC & Consent",
  "kyc.coborrower_requested": "KYC & Consent",
  "kyc.docs_shared": "KYC & Consent",
  "kyc.final_decision": "KYC & Consent",
  "consent.sent": "KYC & Consent",
  "consent.signed": "KYC & Consent",
  "consent.verified": "KYC & Consent",
  kyc_verification_submitted: "KYC & Consent",
  kyc_docs_requested: "KYC & Consent",
  kyc_rejected: "KYC & Consent",
  kyc_accepted: "KYC & Consent",
  kyc_approved_final: "KYC & Consent",
  kyc_rejected_final: "KYC & Consent",
  step_3_cleared: "KYC & Consent",
  step_3_dealer_action_required: "KYC & Consent",

  // --- The NBFC ⇄ Admin ⇄ Dealer request loop ---
  nbfc_doc_request: "NBFC Requests",
  "nbfc.request_raised": "NBFC Requests",
  "nbfc.request_forwarded": "NBFC Requests",
  "nbfc.request_pushed": "NBFC Requests",
  "nbfc.request_declined": "NBFC Requests",
  "nbfc.doc_uploaded": "NBFC Requests",
  "nbfc.doc_verified": "NBFC Requests",
  "nbfc.doc_rejected": "NBFC Requests",
  "nbfc.verdict_raised": "NBFC Requests",
  "nbfc.verdict_responded": "NBFC Requests",

  // --- Field investigation ---
  "fi.requested": "Field Investigation",
  "fi.assigned": "Field Investigation",
  "fi.submitted": "Field Investigation",
  "fi.reviewed": "Field Investigation",
  "fi.reinspection": "Field Investigation",

  // --- Video KYC ---
  "vkyc.initiated": "Video KYC",
  "vkyc.captured": "Video KYC",
  "vkyc.approved": "Video KYC",
  "vkyc.rejected": "Video KYC",

  // --- E-NACH ---
  "enach.registered": "E-NACH",
  "enach.confirmed": "E-NACH",
  "enach.failed": "E-NACH",
  "enach.waived": "E-NACH",

  // --- Loan agreement ---
  "agreement.initiated": "Agreements",
  "agreement.signed": "Agreements",
  "agreement.recorded": "Agreements",

  // --- Loan & sanction ---
  "loan.offer_submitted": "Loan & Sanction",
  "loan.winner_selected": "Loan & Sanction",
  "loan.not_selected": "Loan & Sanction",
  "loan.sanctioned": "Loan & Sanction",
  "loan.rejected": "Loan & Sanction",
  "loan.disbursed": "Loan & Sanction",
  loan_sanctioned: "Loan & Sanction",
  loan_rejected: "Loan & Sanction",

  // --- Product selection, dispatch, delivery ---
  "product.submitted": "Product & Dispatch",
  "product.approved": "Product & Dispatch",
  "product.rejected": "Product & Dispatch",
  "product.docs_uploaded": "Product & Dispatch",
  "product.cash_sale": "Product & Dispatch",
  "product.dispatched": "Product & Dispatch",
  "product.delivered": "Product & Dispatch",
  product_selection_submitted: "Product & Dispatch",
  cash_sale_confirmed: "Product & Dispatch",
  dispatch_confirmed: "Product & Dispatch",
  delivery_confirmed: "Product & Dispatch",

  // --- Inventory ---
  inventory_assigned: "Inventory",
  inventory_transfer_incoming: "Inventory",
  inventory_transfer_acknowledged: "Inventory",
  // E-230 — the OEM price register. Filed under Inventory rather than System
  // because the thing being nagged about is a product's price, and the person
  // who fixes it goes to the same place they maintain models.
  "oem.price_expiring": "Inventory",
  "oem.price_missing": "Inventory",

  // --- Vendor & NBFC ops ---
  "vendor.registered": "Onboarding",
  "nbfc.dual_approval": "System",
  "nbfc.wallet_low": "System",

  // --- Escalations / internal ---
  escalation_raised: "Escalations",
  escalation_resolved: "Escalations",
  "escalation.raised": "Escalations",
  "escalation.resolved": "Escalations",
};

/** Something went wrong or a decision is blocked — surfaced red. */
const CRITICAL = new Set([
  "kyc.rejected",
  "kyc_rejected",
  "kyc_rejected_final",
  "loan.rejected",
  "loan_rejected",
  "onboarding.rejected",
  "nbfc.doc_rejected",
  "vkyc.rejected",
  "enach.failed",
  "escalation_raised",
  "escalation.raised",
]);

/** Waiting on the recipient to act — surfaced amber. */
const WARNING = new Set([
  "kyc.docs_requested",
  "kyc_docs_requested",
  "kyc.coborrower_requested",
  "step_3_dealer_action_required",
  "onboarding.correction_requested",
  "nbfc.request_raised",
  "nbfc.request_forwarded",
  "nbfc.doc_uploaded",
  "nbfc.verdict_raised",
  "fi.requested",
  "fi.assigned",
  "fi.reinspection",
  "vkyc.initiated",
  "agreement.initiated",
  "consent.sent",
  "product.submitted",
  "loan.offer_submitted",
  "vendor.registered",
  "nbfc.dual_approval",
  "nbfc.wallet_low",
  // E-230 — both are "act before a date", which is exactly amber. A lapsed OEM
  // price is not an error anywhere; it just quietly sends every quote for that
  // model to the CEO, which is why it has to be visible BEFORE it happens.
  "oem.price_expiring",
  "oem.price_missing",
]);

/**
 * Types that must NOT generate an email — pure FYI, high volume, or already
 * covered by a bespoke email elsewhere. Everything else is email-worthy, which
 * is the safer default for an action-driven CRM: a missed approval costs more
 * than an extra message.
 */
const NO_EMAIL = new Set([
  "inventory_assigned",
  "inventory_transfer_incoming",
  "inventory_transfer_acknowledged",
  "kyc_accepted",
  "kyc.verified",
  "nbfc.doc_verified",
  "lead.assigned",
  "onboarding.chat_started",
  "onboarding.docs_uploaded",
  "product.delivered",
  "delivery_confirmed",
]);

export function categorize(type: string): NotificationCategory {
  if (isBuyback(type)) return buybackCategorize(type);
  return CATEGORY_BY_TYPE[type] ?? "System";
}

export function priorityOf(type: string): NotificationPriority {
  if (isBuyback(type)) return buybackPriorityOf(type);
  if (CRITICAL.has(type)) return "Critical";
  if (WARNING.has(type)) return "Warning";
  return "Info";
}

/** Whether `emit()` should also send an email, absent an explicit override. */
export function emailWorthy(type: string): boolean {
  if (isBuyback(type)) return false; // buyback dispatches its own email channel
  return !NO_EMAIL.has(type);
}

/**
 * A SQL-friendly filter for one category. Category is DERIVED from `type`, not
 * stored, so filtering by category means filtering by the set of types that map
 * to it. `System` is the catch-all — it also owns every unmapped type — so it is
 * expressed as NOT IN (every mapped non-System type), which keeps a future
 * unmapped type showing up there rather than vanishing.
 */
export function typeFilterForCategory(
  category: NotificationCategory,
): { types: string[]; negate: boolean } {
  // Buyback stores `buyback.<action>`; its own filter already returns those
  // fully-qualified strings, so borrow them rather than rebuild the list here.
  // Its "System" case is the negated one, and its `types` there enumerate every
  // non-System buyback type — exactly what our own System case must exclude.
  const everyBuybackType = buybackTypeFilter("System").types;

  if (category === "System") {
    const mapped = Object.entries(CATEGORY_BY_TYPE)
      .filter(([, c]) => c !== "System")
      .map(([t]) => t);
    return { types: [...mapped, ...everyBuybackType], negate: true };
  }

  const own = Object.entries(CATEGORY_BY_TYPE)
    .filter(([, c]) => c === category)
    .map(([t]) => t);
  const fromBuyback = (BUYBACK_CATEGORIES as string[]).includes(category)
    ? buybackTypeFilter(category as BuybackCategory).types
    : [];
  return { types: [...own, ...fromBuyback], negate: false };
}

export interface NotificationLinkData {
  href?: string | null;
  url?: string | null;
  leadId?: string | null;
  request_id?: string | null;
  dealerId?: string | null;
  [k: string]: unknown;
}

/**
 * FALLBACK deep link for a row that carries no `data.href` (pre-`emit()` rows).
 * Role decides the portal; the domain of `type` decides the surface.
 */
export function linkFor(
  role: NotificationRole,
  type: string,
  data: NotificationLinkData | null | undefined,
  leadId?: string | null,
): string | null {
  const d = data ?? {};
  if (typeof d.href === "string" && d.href) return d.href;
  if (typeof d.url === "string" && d.url) return d.url;

  if (isBuyback(type) || d.request_id) {
    return buybackLinkFor(role, buybackCategorize(type), d);
  }

  const lead = leadId ?? (typeof d.leadId === "string" ? d.leadId : null);
  const category = categorize(type);

  if (category === "Onboarding") {
    const dealerId = typeof d.dealerId === "string" ? d.dealerId : null;
    if (role === "dealer") return "/dealer-portal/onboarding-status";
    return dealerId ? `/admin/dealer-verification/${dealerId}` : "/admin/dealer-verification";
  }

  if (category === "Inventory") {
    return role === "dealer" ? "/dealer-portal/inventory" : "/admin/inventory";
  }

  if (category === "Escalations") {
    return role === "dealer" ? null : "/admin/escalations";
  }

  if (!lead) return null;

  switch (role) {
    case "nbfc":
      return `/nbfc/acquire/${lead}`;
    case "dealer":
      return `/dealer-portal/leads/${lead}`;
    case "vendor":
      return null;
    default:
      return `/admin/kyc-review/${lead}`;
  }
}
