// Module 2 — ASM workspace shared types. Imports BRD enums from the
// foundation. The wire format mirrors src/lib/inside-sales/types.ts where
// fields overlap so frontend components can be shared.

import type { LeadStatus } from "@/lib/lifecycle/transitions";
import type { LeadAssignedBy } from "@/lib/leads/leadAssignedBy";

export const ASM_QUEUE_TABS = [
    "my_visits",
    "today",
    "territory",
    "my_closed",
] as const;
export type AsmQueueTab = (typeof ASM_QUEUE_TABS)[number];

export const ASM_TAB_LABELS: Record<AsmQueueTab, string> = {
    my_visits: "My Active Visits",
    today: "Today's Schedule",
    territory: "Territory Feed",
    my_closed: "My Closed",
};

// Visit lifecycle (BRD §0.8) — mirrors lead_visits.visit_status enum.
export const VISIT_STATUS = [
    "pending_scheduling",
    "scheduled",
    "visited",
    "postponed",
    "cancelled",
    "no_show",
] as const;
export type VisitStatus = (typeof VISIT_STATUS)[number];

export const VISIT_OUTCOME = [
    "productive",
    "dealer_not_present",
    "dealer_uninterested",
    "commercials_progressed",
    "scheduling_issue",
    "other",
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOME)[number];

// User-facing outcome labels. The auto-engage mechanics are an internal
// implementation detail (see ENGAGED_OUTCOMES) and are deliberately not
// surfaced in these labels.
export const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
    productive: "Productive",
    dealer_not_present: "Dealer not present",
    dealer_uninterested: "Dealer uninterested",
    commercials_progressed: "Commercials progressed",
    scheduling_issue: "Scheduling issue",
    other: "Other",
};

export const VISIT_NEXT_ACTION = [
    "next_visit",
    "convert",
    "lost",
    "escalate",
] as const;
export type VisitNextAction = (typeof VISIT_NEXT_ACTION)[number];

// Auto-engaged outcomes per BRD §0.1 Glossary.
export const ENGAGED_OUTCOMES: VisitOutcome[] = ["productive", "commercials_progressed"];

export type AsmQueueRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    final_intent_score: number | null;
    lead_status: LeadStatus | null;
    interest_level: string | null;
    current_owner_id: string | null;
    current_owner_name: string | null;
    asm_id: string | null;
    asm_name: string | null;
    last_touchpoint_at: string | null;
    assigned_at: string | null;
    visit_status: VisitStatus | null;
    visit_outcome: VisitOutcome | null;
    scheduled_date: string | null;
    actual_visit_date: string | null;
    closed_at: string | null;
    /**
     * Who handed this lead to its current owner — the "sent by …" stamp. Mirrors
     * QueueRow.assigned_by (src/lib/inside-sales/types.ts): decorated onto the
     * page in the route, never selected by fetchAsmQueueRows, hence optional.
     */
    assigned_by?: LeadAssignedBy | null;
};

export type AsmQueueResponse = {
    rows: AsmQueueRow[];
    total: number;
    page: number;
    limit: number;
    tab: AsmQueueTab;
};

export type AsmQueueCounts = Record<AsmQueueTab, number>;

export type VisitInput = {
    visit_status: VisitStatus;
    actual_visit_date?: string | null;
    scheduled_date?: string | null;
    visit_outcome?: VisitOutcome | null;
    visit_remarks: string;
    photos?: string[];
    gps_check_in_lat?: number | null;
    gps_check_in_lng?: number | null;
    next_action: VisitNextAction;
    next_visit_date?: string | null;
};
