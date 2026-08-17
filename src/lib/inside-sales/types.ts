// Module 1 — Inside Sales Rep workspace shared types.
// Imports lifecycle enums from the foundation so the wire format reuses the
// same source of truth.

import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import type { LeadAssignedBy } from "@/lib/leads/leadAssignedBy";
import type {
    CallStatus,
    NextAction,
    TouchpointType,
} from "@/lib/lifecycle/touchpointTypes";

export const QUEUE_TABS = [
    "my_open",
    "follow_ups",
    "unassigned",
    "team",
    "my_closed",
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const TAB_LABELS: Record<QueueTab, string> = {
    my_open: "My Open Leads",
    follow_ups: "Follow-ups Today",
    unassigned: "Unassigned (Claim)",
    team: "Team (Read-only)",
    my_closed: "My Closed Leads",
};

export type QueueRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    language: string | null;
    final_intent_score: number | null;
    lead_status: LeadStatus | null;
    interest_level: string | null;
    current_owner_id: string | null;
    current_owner_name: string | null;
    last_touchpoint_at: string | null;
    next_follow_up_at: string | null;
    total_attempts: number | null;
    assigned_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    /**
     * `dealer_leads.neodove_sync_status` — pushed | inbound | priority_dial |
     * failed, or null for a lead that has never been near NeoDove. Drives the
     * row's NeoDove chip. Null on any database without E-224 (it is read through
     * to_jsonb precisely so that is a null and not a 500).
     */
    neodove_sync_status: string | null;
    /**
     * Who handed this lead to its current owner — the "sent by CEO Test [CEO]"
     * stamp. Decorated onto the page in the route, not selected in the queue
     * query (see fetchAssignedByForLeads), which is why it is OPTIONAL: every
     * other consumer of this type — LeadDetailLead extends it — would otherwise
     * be claiming a field its own query never selects.
     */
    assigned_by?: LeadAssignedBy | null;
};

export type QueueResponse = {
    rows: QueueRow[];
    total: number;
    page: number;
    limit: number;
    tab: QueueTab;
};

export type QueueCounts = Record<QueueTab, number>;

// Lead Detail bundle returned by GET /api/inside-sales/lead/[id].
// Shape kept flat-ish so each pane component reads one branch.

export type LeadDetailLead = QueueRow & {
    area: string | null;
    pincode: string | null;
    timezone: string | null;
    overall_summary: string | null;
    ai_session_id: string | null;
    originator_id: string | null;
    originator_name: string | null;
    closing_owner_id: string | null;
    closing_owner_name: string | null;
    closing_role: string | null;
    asm_id: string | null;
    asm_name: string | null;
    closed_at: string | null;
    pre_transfer_status: LeadStatus | null;
    lost_reason: LostReason | null;
    lost_reason_notes: string | null;
    previous_lost_reason: LostReason | null;
    onboarding_dropout_reason: string | null;
    onboarding_dropout_notes: string | null;
    escalation_status: string | null;
    escalation_count: number;
    last_escalation_id: string | null;
    preliminary_payment_intent: string | null;
    segments: string[];
    address_history: unknown[];
    address_notes: string | null;
    brochure_sent_at: string | null;
    // Conversion → Onboarding (BRD §0.13). Set once the lead is Converted and a
    // draft dealer_onboarding_applications row exists; powers the header banner.
    dealer_onboarding_application_id: string | null;
    onboarding_status: string | null;
    onboarding_created_at: string | null;
};

export type LeadDetailTouchpoint = {
    touchpoint_id: string;
    touchpoint_type: TouchpointType;
    performed_by: string | null;
    performed_by_name: string | null;
    performed_at: string;
    call_status: CallStatus | null;
    call_duration_sec: number | null;
    is_engaged: boolean;
    remarks: string | null;
    attachments: unknown[];
    next_action: NextAction | null;
    next_action_at: string | null;
};

// One product line-item on a commercials quote (E-128). asset_type maps to
// the three product-master tables; unit_price is snapshotted at quote time.
export type AssetType = "battery" | "charger" | "paraphernalia";

export type CommercialsProductLine = {
    asset_type: AssetType;
    product_id: string;
    product_name: string;
    model_id: string;
    unit_price: number | null;
    quantity: number;
};

// One product-master option for the picker dropdown.
export type ProductMasterOption = {
    id: string;
    label: string;
    model_id: string;
    detail: string | null;
    unit_price: number | null;
    max_quantity: number | null;
};

export type ProductMasterResponse = {
    battery: ProductMasterOption[];
    charger: ProductMasterOption[];
    paraphernalia: ProductMasterOption[];
};

export type LeadDetailCommercials = {
    commercial_id: string;
    version_no: number;
    is_current: boolean;
    event_type: string;
    price_quoted: string | null;
    quote_document_url: string | null;
    brochure_url: string | null;
    brochure_sent_at: string | null;
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    final_price: string | null;
    payment_method: string | null;
    deal_notes: string | null;
    product_lines: CommercialsProductLine[];
    notes: string | null;
    created_by: string | null;
    created_at: string;
    withdrawn_at: string | null;
    // E-221 / E-226 approval gate. Nullable because a pre-E-221 row carries
    // nothing, and approval_mode is deliberately NULL on ungated events.
    approval_status: string | null;
    approval_mode: string | null;
    approved_at: string | null;
    rejection_reason: string | null;
    // E-242 generated draft. quote_pdf_url is the SYSTEM document; the separate
    // quote_document_url above is whatever the rep attached by hand.
    quote_number: string | null;
    quote_pdf_url: string | null;
    quote_pdf_generated_at: string | null;
    quote_pdf_error: string | null;
    // E-243 — what the DEALER said, orthogonal to approval_status above (which
    // is iTarang's own gate). NULL until they answer.
    dealer_decision: string | null;
    dealer_decision_at: string | null;
    dealer_decision_via: string | null;
    dealer_decision_note: string | null;
};

export type LeadDetailStatusHistory = {
    history_id: string;
    from_status: LeadStatus | null;
    to_status: LeadStatus;
    from_lost_reason: LostReason | null;
    to_lost_reason: LostReason | null;
    changed_by: string | null;
    changed_by_name: string | null;
    changed_at: string;
    reason_notes: string | null;
};

export type LeadDetailBundle = {
    lead: LeadDetailLead;
    current_commercials: LeadDetailCommercials | null;
    commercials_history: LeadDetailCommercials[];
    touchpoints: LeadDetailTouchpoint[];
    status_history: LeadDetailStatusHistory[];
};

// ───────────────────────────── action payloads ────────────────────────────

export type TouchpointInput = {
    touchpoint_type: TouchpointType;
    performed_at?: string;
    call_status?: CallStatus | null;
    call_duration_sec?: number | null;
    is_engaged?: boolean;
    remarks?: string;
    attachments?: unknown[];
    next_action?: NextAction | null;
    next_action_at?: string | null;
    status_change?: {
        to: LeadStatus;
        reason_notes?: string | null;
    };
    follow_up_at?: string | null;
};

export type CommercialsInput = {
    event_type:
        | "brochure_share"
        | "quote_issue"
        | "quote_revision"
        | "terms_update"
        | "final_terms";
    price_quoted?: number | null;
    quote_document_url?: string | null;
    brochure_url?: string | null;
    credit_terms?: string | null;
    delivery_terms?: string | null;
    warranty_terms?: string | null;
    final_price?: number | null;
    payment_method?: "cash" | "finance" | null;
    deal_notes?: string | null;
    product_lines?: CommercialsProductLine[];
    notes?: string | null;
};

export type TransferAsmInput = {
    asm_id: string;
    reason: "Commercials_Finalised" | "Site_Visit_Needed" | "Negotiation_Beyond_IS_Authority" | "Demo_Requested" | "Other";
    visit_type: "Initial_Visit" | "Demo" | "Negotiation" | "Closing";
    suggested_visit_date?: string | null;
    dealer_preferred_time?: string | null;
    handoff_notes: string;
    pending_items?: string[];
    out_of_territory_reason?: string | null;
};

export type MarkLostInput = {
    lost_reason: LostReason;
    lost_reason_notes?: string | null;
    confirmed_high_impact?: boolean;
};

export type MarkConvertedInput = {
    notes?: string | null;
};

export type ReassignInput = {
    target_user_id: string;
    reason: string;
    notify_admin?: boolean;
};

export type EscalateInput = {
    escalation_reason: string;
    escalation_notes: string;
    suggested_action?: string | null;
    urgency: "normal" | "high" | "urgent";
};

export type AsmOption = {
    user_id: string;
    name: string | null;
    email: string;
    in_territory: boolean;
};
