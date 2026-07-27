// Human-readable stage for a WhatsApp onboarding conversation.
//
// `whatsapp_onboarding_sessions.current_state` is code-owned and deliberately not
// DB-constrained, so the admin console can't rely on the DB to describe it. This
// module is the single mapping both the API and the UI import, which is what
// stops a badge in the table from disagreeing with a filter in the API.
//
// Pure and dependency-free — safe to import from a "use client" component.

export type WaStage =
  | "new_enquiry"
  | "choosing_path"
  | "general_enquiry"
  | "identifying"
  | "collecting_docs"
  | "answering_fields"
  | "confirming"
  | "submitted"
  | "correction"
  | "rejected"
  | "approved"
  | "customer_lead"
  | "operator_menu"
  | "unknown";

export const STAGE_LABEL: Record<WaStage, string> = {
  new_enquiry: "Just said hi",
  choosing_path: "Choosing what they need",
  general_enquiry: "Asking general questions",
  identifying: "Choosing business type",
  collecting_docs: "Uploading documents",
  answering_fields: "Answering questions",
  confirming: "Confirming details",
  submitted: "Submitted for review",
  correction: "Fixing corrections",
  rejected: "Rejected",
  approved: "Approved dealer",
  customer_lead: "Creating a customer lead",
  operator_menu: "Operator menu",
  unknown: "In conversation",
};

export type StageTone = "neutral" | "info" | "success" | "warning" | "danger";

export const STAGE_TONE: Record<WaStage, StageTone> = {
  new_enquiry: "neutral",
  choosing_path: "neutral",
  general_enquiry: "neutral",
  identifying: "info",
  collecting_docs: "info",
  answering_fields: "info",
  confirming: "info",
  submitted: "success",
  correction: "warning",
  rejected: "danger",
  approved: "success",
  customer_lead: "info",
  operator_menu: "neutral",
  unknown: "neutral",
};

// Every state the onboarding/console state machines assign, mapped to a stage an
// admin can read at a glance. CAP_* belong to the E-170 dealer-orchestrator fork,
// which is commented out in runTurn — kept here so old rows still render.
const STATE_STAGE: Record<string, WaStage> = {
  GREETING: "new_enquiry",
  MENU: "new_enquiry",
  ASK_RESUME: "new_enquiry",
  CHOOSE_FLOW: "choosing_path",
  GENERAL_INFO: "general_enquiry",
  ASK_COMPANY_TYPE: "identifying",
  ASK_UPLOAD_MODE: "identifying",
  COLLECTING_DOC: "collecting_docs",
  ASK_FIELD: "answering_fields",
  ASK_FINANCE: "answering_fields",
  ASK_SIGNER_CHOICE: "answering_fields",
  ASK_SIGNER_FIELD: "answering_fields",
  CONFIRM_SIGNER: "answering_fields",
  CAP_NAME: "answering_fields",
  CAP_MOBILE: "answering_fields",
  CAP_EMAIL: "answering_fields",
  CAP_ADDRESS: "answering_fields",
  AWAIT_CONFIRM: "confirming",
  SUBMITTED: "submitted",
  CORRECTION: "correction",
  REJECTED: "rejected",
};

/**
 * Resolve the stage for one conversation.
 *
 * Application status wins over conversation state: an admin's approve/reject only
 * touches `dealer_onboarding_applications`, while the session keeps whatever
 * state it was parked in, so reading the session first would show a rejected
 * dealer as still "Uploading documents".
 */
export function stageOf(input: {
  currentState?: string | null;
  onboardingStatus?: string | null;
  reviewStatus?: string | null;
}): WaStage {
  const status = (input.onboardingStatus ?? "").toLowerCase();
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "correction_requested") return "correction";
  if (status === "submitted") return "submitted";

  const state = (input.currentState ?? "").toUpperCase();
  if (!state) return "unknown";
  // Post-approval dealer console and the internal operator menu are prefixed.
  if (state.startsWith("DC_")) return "customer_lead";
  if (state.startsWith("OP_")) return "operator_menu";

  return STATE_STAGE[state] ?? "unknown";
}

export function stageLabel(stage: WaStage): string {
  return STAGE_LABEL[stage] ?? STAGE_LABEL.unknown;
}

/**
 * `onboarding_status` values that decide a stage on their own, bypassing the
 * conversation state entirely (the precedence block at the top of `stageOf`).
 */
export const TERMINAL_STAGE_STATUS: Partial<Record<WaStage, string>> = {
  approved: "approved",
  rejected: "rejected",
  correction: "correction_requested",
  submitted: "submitted",
};

export const TERMINAL_STATUSES = Object.values(TERMINAL_STAGE_STATUS);

/**
 * Reverse of STATE_STAGE — the conversation states that resolve to each stage.
 * Lets a caller filter by stage in SQL instead of after pagination (which would
 * silently return short pages). `customer_lead` and `operator_menu` are prefix
 * matches, so they are absent here; see `STAGE_STATE_PREFIX`.
 */
export const STAGE_STATES: Partial<Record<WaStage, string[]>> = (() => {
  const out: Partial<Record<WaStage, string[]>> = {};
  for (const [state, stage] of Object.entries(STATE_STAGE)) {
    (out[stage] ??= []).push(state);
  }
  return out;
})();

export const STAGE_STATE_PREFIX: Partial<Record<WaStage, string>> = {
  customer_lead: "DC_",
  operator_menu: "OP_",
};

// ── Who is this contact? ────────────────────────────────────────────────────
//
// There is no explicit "I'm a dealer" marker in the session: picking Customer at
// CHOOSE_FLOW sets `context.flow = 'customer'` (and returning to dealer onboarding
// clears it again), while picking Dealer just walks the sender into the
// company-type question. So "dealer" is inferred from having entered the dealer
// onboarding flow at all — which is exactly what the states below represent.

export type ContactType = "dealer" | "customer" | "enquiry" | "undecided";

export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  dealer: "Dealer",
  customer: "Customer",
  enquiry: "General enquiry",
  undecided: "Not chosen yet",
};

/** States that only occur once the sender is being onboarded as a dealer. */
export const DEALER_ONBOARDING_STATES = [
  "ASK_COMPANY_TYPE",
  "ASK_UPLOAD_MODE",
  "COLLECTING_DOC",
  "ASK_FIELD",
  "ASK_FINANCE",
  "ASK_SIGNER_CHOICE",
  "ASK_SIGNER_FIELD",
  "CONFIRM_SIGNER",
  "AWAIT_CONFIRM",
  "SUBMITTED",
  "CORRECTION",
  "REJECTED",
];

export function contactTypeOf(input: {
  currentState?: string | null;
  /** `whatsapp_onboarding_sessions.context->>'flow'` */
  flow?: string | null;
  companyType?: string | null;
  onboardingStatus?: string | null;
}): ContactType {
  if ((input.flow ?? "") === "customer") return "customer";

  const state = (input.currentState ?? "").toUpperCase();
  const status = (input.onboardingStatus ?? "").toLowerCase();

  // An approved dealer chatting in the post-approval console (DC_*) is still a
  // dealer — the lead they're building belongs on the customer-leads tab.
  if (
    status === "approved" ||
    status === "submitted" ||
    status === "rejected" ||
    status === "correction_requested" ||
    input.companyType ||
    state.startsWith("DC_") ||
    DEALER_ONBOARDING_STATES.includes(state)
  ) {
    return "dealer";
  }

  if (state === "GENERAL_INFO") return "enquiry";
  return "undecided";
}

export type WaActivity = "live" | "recent" | "stale";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * ONE_HOUR_MS;

/**
 * How warm the conversation is. "stale" also covers a contact who messaged once
 * and never came back — which is exactly the population this console exists to
 * make visible, so it is a label, never a filter that hides them by default.
 */
export function activityOf(
  lastInboundAt: Date | string | null | undefined,
  now: Date = new Date(),
): WaActivity {
  if (!lastInboundAt) return "stale";
  const ts = new Date(lastInboundAt).getTime();
  if (Number.isNaN(ts)) return "stale";
  const age = now.getTime() - ts;
  if (age < ONE_HOUR_MS) return "live";
  if (age < FORTY_EIGHT_HOURS_MS) return "recent";
  return "stale";
}

export const ACTIVITY_LABEL: Record<WaActivity, string> = {
  live: "Active now",
  recent: "Recent",
  stale: "Stalled",
};
