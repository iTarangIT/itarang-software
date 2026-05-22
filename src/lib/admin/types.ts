// Module 3 — Admin Dashboard / Bulk Upload / Escalations / Reports shared types.
// BRD §0.4 (bulk upload), §0.6 (escalations), §0.11 (dashboard + reports),
// §0.13 (onboarding dropout loopback). Wire format reused by both the API
// routes and the client components.

import type {
    LeadDetailTouchpoint,
    LeadDetailStatusHistory,
} from "@/lib/inside-sales/types";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

// ─────────────────────────────── Dashboard ────────────────────────────────

// BRD §0.11 Zone 1 — KPI strip (8 tiles + the logging-compliance tile).
export type AdminKpis = {
    unassigned_queue: number;
    avg_time_to_first_touch_hours: number | null;
    leads_worked_today: number;
    conversion_rate_7d: number | null; // 0..1
    conversion_rate_30d: number | null; // 0..1
    pending_escalations: number;
    onboarding_dropouts_pending: number;
    stale_converted: number;
    // Logging compliance: status changes with no touchpoint within ±1h.
    compliance_status_without_touchpoint: number;
};

// BRD §0.11 Zone 2 — one row per IS Rep / ASM.
export type TeamPerfRow = {
    user_id: string;
    user_name: string | null;
    role: string | null;
    open_leads: number;
    touchpoints_today: number;
    touchpoints_week: number;
    avg_touchpoints_per_lead: number | null;
    avg_time_to_first_touch_hours: number | null;
    conversion_rate_30d: number | null;
    stale_leads: number; // open, no touch > 5 days
    critical_stale: number; // open, no touch > 10 days
    ooo_status: string | null;
};

// BRD §0.11 Zone 3 — 11 alert panels.
export const ALERT_PANELS = [
    "no_touch_5d",
    "no_touch_10d",
    "awaiting_decision_14d",
    "pending_escalations",
    "onboarding_dropouts",
    "stale_converted",
    "onboarding_stalled",
    "asm_no_activity",
    "address_mismatch",
    "duplicate_merge_requests",
    "out_of_territory_handoffs",
] as const;
export type AlertPanelKey = (typeof ALERT_PANELS)[number];

export const ALERT_PANEL_LABELS: Record<AlertPanelKey, string> = {
    no_touch_5d: "No Touch > 5 working days",
    no_touch_10d: "No Touch > 10 working days",
    awaiting_decision_14d: "Awaiting Customer Decision > 14 days",
    pending_escalations: "Pending Escalations",
    onboarding_dropouts: "Onboarding Dropouts Pending Review",
    stale_converted: "Stale Converted (no onboarding activity 3+ days)",
    onboarding_stalled: "Onboarding Stalled (> 30 days)",
    asm_no_activity: "ASM No Activity After Handoff",
    address_mismatch: "Address Mismatch Review",
    duplicate_merge_requests: "Duplicate Merge Requests",
    out_of_territory_handoffs: "Out-of-Territory Handoffs",
};

// Generic drill-down row used by every alert panel.
export type AlertPanelRow = {
    id: string;
    primary: string;
    secondary: string | null;
    meta: string | null;
    href: string;
};

export type DashboardFilters = {
    date_from?: string | null;
    date_to?: string | null;
    owner_id?: string | null;
    status?: string | null;
    source?: string | null;
    segment?: string | null;
    city?: string | null;
    state?: string | null;
    follow_up_due_today?: boolean;
    reactivated_only?: boolean;
};

export type DashboardResponse = {
    kpis: AdminKpis;
    team: TeamPerfRow[];
    alert_counts: Record<AlertPanelKey, number>;
};

// ────────────────────────────── Escalations ───────────────────────────────

export const ESCALATION_RESOLUTION_ACTIONS = [
    "reassign",
    "returned",
    "no_action",
] as const;
export type EscalationResolutionAction =
    (typeof ESCALATION_RESOLUTION_ACTIONS)[number];

export type EscalationQueueRow = {
    escalation_id: string;
    dealer_lead_id: string;
    dealer_name: string | null;
    phone: string | null;
    city: string | null;
    escalation_reason: string;
    urgency: string; // normal / high / urgent
    status: string; // pending_review / resolved
    raised_by: string;
    raised_by_name: string | null;
    raised_at: string;
    resolved_at: string | null;
    resolution_action: string | null;
    has_ceo_input: boolean;
    current_owner_id: string | null;
    current_owner_name: string | null;
};

export type EscalationDetail = {
    escalation_id: string;
    dealer_lead_id: string;
    escalation_reason: string;
    escalation_notes: string;
    suggested_action: string | null;
    urgency: string;
    status: string;
    raised_by: string;
    raised_by_name: string | null;
    raised_at: string;
    ceo_comment: string | null;
    ceo_recommendation: string | null;
    ceo_recommended_at: string | null;
    resolved_by: string | null;
    resolved_by_name: string | null;
    resolved_at: string | null;
    resolution_action: string | null;
    resolution_notes: string | null;
};

export type EscalationLeadSummary = {
    id: string;
    dealer_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: LeadStatus | null;
    current_owner_id: string | null;
    current_owner_name: string | null;
};

export type EscalationThreadBundle = {
    escalation: EscalationDetail;
    lead: EscalationLeadSummary;
    touchpoints: LeadDetailTouchpoint[];
    status_history: LeadDetailStatusHistory[];
};

// ──────────────────────────── Merge requests ──────────────────────────────

// BRD §0.4 — resolution actions differ by request_type.
export const ADDRESS_MISMATCH_ACTIONS = [
    "same_dealer_relocated",
    "data_error_reject",
    "different_branch_same_owner",
    "different_dealer_sharing_number",
    "skip_keep_existing",
] as const;
export type AddressMismatchAction = (typeof ADDRESS_MISMATCH_ACTIONS)[number];

export const PHONE_COLLISION_ACTIONS = [
    "accepted_manual",
    "rejected",
    "deferred",
] as const;
export type PhoneCollisionAction = (typeof PHONE_COLLISION_ACTIONS)[number];

export const MERGE_ACTION_LABELS: Record<string, string> = {
    same_dealer_relocated: "Same dealer relocated",
    data_error_reject: "Data error — reject",
    different_branch_same_owner: "Different branch / same owner",
    different_dealer_sharing_number: "Different dealer sharing number",
    skip_keep_existing: "Skip / keep existing",
    accepted_manual: "Accepted — merged manually",
    rejected: "Rejected — not a duplicate",
    deferred: "Deferred — need more info",
};

export type MergeRequestRow = {
    id: string;
    request_type: string;
    source_lead_id: string | null;
    target_lead_id: string;
    target_dealer_name: string | null;
    target_phone: string | null;
    source_dealer_name: string | null;
    requested_by: string | null;
    requested_by_name: string | null;
    request_notes: string | null;
    status: string; // pending / accepted / rejected_not_duplicate / deferred
    resolution_action: string | null;
    admin_resolution_notes: string | null;
    resolved_at: string | null;
    created_at: string;
};

// ───────────────────────── Onboarding dropouts ────────────────────────────

// BRD §0.7 — onboarding_dropout_reason enum (6 values).
export const ONBOARDING_DROPOUT_REASONS = [
    "kyc_failed",
    "compliance_issue",
    "dealer_withdrew",
    "loan_rejected",
    "inactivity_stalled",
    "other_dropout",
] as const;
export type OnboardingDropoutReason =
    (typeof ONBOARDING_DROPOUT_REASONS)[number];

export const DROPOUT_RESOLUTION_ACTIONS = [
    "keep_converted",
    "flip_to_lost",
    "re_engage",
] as const;
export type DropoutResolutionAction =
    (typeof DROPOUT_RESOLUTION_ACTIONS)[number];

export type OnboardingDropoutRow = {
    id: string; // dealer_lead id
    dealer_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    closed_at: string | null;
    onboarding_application_id: string | null;
    onboarding_status: string | null;
    onboarding_last_action_at: string | null;
    dropout_kind: "rejected" | "withdrawn" | "stalled";
    current_owner_id: string | null;
    current_owner_name: string | null;
};

// ──────────────────────────────── Reports ─────────────────────────────────

export const REPORT_TYPES = [
    "daily_activity",
    "lead_funnel",
    "lost_analysis",
    "ai_score_accuracy",
    "source_performance",
    "asm_handoff",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_LABELS: Record<ReportType, string> = {
    daily_activity: "Daily Activity",
    lead_funnel: "Lead Funnel",
    lost_analysis: "Lost Analysis",
    ai_score_accuracy: "AI Score Accuracy",
    source_performance: "Source Performance",
    asm_handoff: "ASM Handoff Report",
};

export type ReportColumn = { key: string; label: string; numeric?: boolean };
export type ReportRow = Record<string, string | number | null>;

export type ReportResult = {
    type: ReportType;
    columns: ReportColumn[];
    rows: ReportRow[];
};

// ──────────────────────────── Bulk upload ─────────────────────────────────

// BRD §0.4 — segment multi-value enum.
export const UPLOAD_SEGMENTS = [
    "3W",
    "2W",
    "Solar",
    "Inverter",
    "Auto-Parts",
    "Battery",
] as const;

// One parsed CSV row before validation.
export type UploadParsedRow = {
    row_number: number;
    phone: string;
    dealer_name: string;
    city: string;
    state: string;
    contact_person?: string;
    email?: string;
    segment?: string;
    monthly_capacity?: string;
    current_supplier?: string;
    language?: string;
    source_label?: string;
    preliminary_payment_intent?: string;
    prior_call_notes?: string;
};

// The cleaned, insertable payload for one valid row.
export type UploadInsertPayload = {
    phone: string; // normalised +91XXXXXXXXXX
    dealer_name: string;
    city: string;
    state: string;
    contact_person: string | null;
    email: string | null;
    segments: string[];
    monthly_capacity: number | null;
    current_supplier: string | null;
    language: string;
    preliminary_payment_intent: string | null;
    prior_call_notes: string | null;
    source_label: string | null;
};

export type UploadRowStatus =
    | "valid"
    | "error"
    | "duplicate_skip"
    | "address_mismatch"
    | "reactivate";

// One row after validation + dedupe classification.
export type UploadRowResult = {
    row_number: number;
    dealer_name: string;
    normalized_phone: string | null;
    city: string;
    state: string;
    status: UploadRowStatus;
    errors: string[];
    location_suggestion: string | null;
    duplicate_lead_id: string | null;
    payload: UploadInsertPayload | null;
};

export type UploadValidationResult = {
    total_rows: number;
    valid_rows: number;
    errored_rows: number;
    duplicate_rows: number;
    address_mismatch_rows: number;
    reactivate_rows: number;
    rows: UploadRowResult[];
};

export type UploadBatchSummary = {
    batch_id: string;
    file_name: string;
    uploaded_by: string;
    uploaded_by_name: string | null;
    total_rows: number;
    valid_rows: number;
    errored_rows: number;
    duplicate_rows: number;
    routing_to_ai: boolean;
    source_label: string | null;
    status: string;
    rollback_window_until: string | null;
    rolled_back_at: string | null;
    created_at: string;
};

// ────────────────────────────── Settings ──────────────────────────────────

export type AssignmentConfig = {
    config_id: string | null;
    intent_score_threshold: number;
    working_hours_start: string;
    working_hours_end: string;
    working_days: string[];
    updated_by: string | null;
    updated_by_name: string | null;
    updated_at: string | null;
};

export type HolidayRow = {
    holiday_id: string;
    holiday_date: string;
    holiday_name: string;
    is_active: boolean;
};

export type TerritoryRow = {
    territory_id: string;
    asm_id: string;
    asm_name: string | null;
    state: string;
    city: string | null;
    active_from: string | null;
    active_to: string | null;
};

export type SettingsBundle = {
    assignment_config: AssignmentConfig;
    holidays: HolidayRow[];
    territories: TerritoryRow[];
};

// Lightweight user option used by every "pick a user" dropdown.
export type UserOption = {
    user_id: string;
    name: string | null;
    email: string;
    role: string | null;
};
