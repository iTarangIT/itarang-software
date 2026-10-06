// How Reports › Data downloads lays the catalogue out (Sales Head redesign,
// 6 Oct 2026): which section each dataset sits in, its one-line grain, and how
// the main sheet's columns are grouped into boxes. CLIENT-SAFE.
//
// Presentation only — it never changes what a file contains. A column the
// registry gains later and nobody adds here shows in an "Other" box, so it is
// never hidden.

import type { DatasetColumn } from "./types";

export const DATASET_SECTIONS = ["SALES", "DEALERS", "MONEY", "BATTERY FINANCE", "LIFECYCLE AND STOCK"] as const;
export type DatasetSection = (typeof DATASET_SECTIONS)[number];

export interface DatasetLayout {
    section: DatasetSection;
    grain: string;
    /** Who the spec says can download it, in words. */
    who: string;
    columnGroups: { name: string; keys: string[] }[];
}

export const DATASET_LAYOUT: Record<string, DatasetLayout> = {
    leads: {
        section: "SALES",
        grain: "One row per dealer lead",
        who: "CEO, Admin, Sales Head (all); ISR and ASM (own leads only)",
        columnGroups: [
            { name: "Identity", keys: ["lead_id", "dealer_name", "phone", "city", "state", "business_type", "gstin"] },
            { name: "Source", keys: ["created_on", "source_door", "source_origin", "campaign", "created_by"] },
            {
                name: "Owner and speed",
                keys: ["owner_name", "owner_role", "sales_ready_on", "sales_ready_reason", "assigned_on", "first_attempt_on", "first_contact_on", "last_worked_on", "idle_working_days", "next_follow_up", "last_visit_date", "next_visit_date", "last_call_at", "next_call_at"],
            },
            {
                name: "Pipeline",
                keys: ["lead_status", "interest_level", "ai_band", "ai_score", "contactability", "last_call_outcome", "quote_value", "quote_state", "latest_remarks"],
            },
            {
                name: "Outcome",
                keys: ["won_at", "closed_by_name", "account_activated_on", "lost_on", "lost_reason", "competitor", "invoices", "billed", "last_invoice"],
            },
        ],
    },
    lead_events: {
        section: "SALES",
        grain: "One row per event on a lead",
        who: "CEO, Admin, Sales Head",
        columnGroups: [
            { name: "Event", keys: ["event_at", "event_type", "from_value", "to_value", "channel", "outcome", "duration_sec", "remarks", "performed_by", "role"] },
            { name: "Lead", keys: ["lead_id", "dealer", "city", "state", "business_type"] },
            { name: "Clocks", keys: ["hours_since_sales_ready"] },
        ],
    },
    calls: {
        section: "SALES",
        grain: "One row per call, human or AI",
        who: "CEO, Admin, Sales Head (all); ISR and ASM (own calls only)",
        columnGroups: [
            { name: "Call", keys: ["performed_at", "lead_id", "dealer", "city", "state", "caller", "caller_role", "channel", "neodove_agent"] },
            { name: "Result", keys: ["connected", "call_status", "disposition_bucket", "disposition", "call_duration_sec", "engaged", "ai_band"] },
            { name: "Evidence", keys: ["recording_url", "remarks"] },
        ],
    },
    visits: {
        section: "SALES",
        grain: "One row per visit, planned or done",
        who: "CEO, Admin, Sales Head (all); ASM (own visits only)",
        columnGroups: [
            {
                name: "Visit",
                keys: ["visit_date", "scheduled_date", "lead_id", "dealer", "city", "state", "visitor", "meeting_mode", "visit_status", "visit_outcome", "new_visit", "visit_remarks", "next_visit_date"],
            },
            { name: "Proof", keys: ["photos", "location_pin"] },
            { name: "Handover", keys: ["transferred_on", "transferred_by", "days_transfer_to_visit"] },
        ],
    },
    quotes: {
        section: "SALES",
        grain: "One row per quote version",
        who: "CEO, Admin, Sales Head (all); ISR and ASM (own quotes only)",
        columnGroups: [
            { name: "Quote", keys: ["quote_number", "version_no", "is_current", "lead_id", "dealer", "created_by", "created_at"] },
            {
                name: "Value",
                keys: ["price_quoted", "final_price", "sub_total", "gst", "total_with_gst", "list_total", "discount", "lowest_vs_oem", "credit_terms", "payment_method"],
            },
            {
                name: "Approval and answer",
                keys: ["approval_status", "approval_mode", "approved_by", "approved_at", "approval_wait_hours", "rejection_reason", "delivered_at", "channels", "dealer_decision", "dealer_decision_at", "dealer_decision_via", "withdrawn_at", "withdraw_reason"],
            },
        ],
    },
    targets: {
        section: "SALES",
        grain: "One row per person, metric and month",
        who: "CEO, Admin, Sales Head; each rep sees their own",
        columnGroups: [
            { name: "Target", keys: ["month", "user_name", "user_role", "metric_label", "ceo_target", "admin_addon", "final_target", "status", "pushed_at", "accepted_at"] },
            { name: "Progress", keys: ["mtd_target", "actual", "pct_of_mtd", "remaining", "required_per_day"] },
        ],
    },
    dealer_accounts: {
        section: "DEALERS",
        grain: "One row per live dealer account",
        who: "CEO, Admin, Sales Head (all); account owners (own accounts)",
        columnGroups: [
            { name: "Account", keys: ["account_id", "dealer", "gstin", "city", "state", "business_type", "dealer_type", "finance_enabled", "agreement_status"] },
            { name: "People", keys: ["came_through", "lead_id", "onboarded_by_name", "owner_name", "owner_since"] },
            {
                name: "Orders",
                keys: ["activated_on", "first_order", "last_order", "days_since_last_order", "bucket_label", "revenue_90d", "revenue_fy", "revenue_lifetime", "orders", "avg_reorder_days", "invoices_matchable"],
            },
        ],
    },
    dealer_onboarding: {
        section: "DEALERS",
        grain: "One row per onboarding application",
        who: "CEO, Admin, Sales Head",
        columnGroups: [
            { name: "Application", keys: ["id", "company_name", "owner_phone", "gst_number", "dealer_type", "started_on", "started_through", "salesperson", "lead_id"] },
            {
                name: "Progress",
                keys: ["onboarding_status", "submitted_at", "finance_enabled", "agreement_status", "agreement_signed_on", "approved_at", "approved_by", "rejection_reason", "times_sent_back", "stalled", "dropout_reason"],
            },
        ],
    },
    invoices: {
        section: "MONEY",
        grain: "One row per sales invoice",
        who: "CEO, Admin",
        columnGroups: [
            { name: "Invoice", keys: ["invoice_number", "invoice_date", "due_date", "source", "entity", "customer_name", "gstin"] },
            { name: "Dealer", keys: ["dealer_name", "dealer_lead_id", "link_status", "business_type", "account", "dealer_owner", "owner_on_invoice_date"] },
            { name: "Money", keys: ["sub_total", "tax_total", "total", "paid", "balance", "status", "days_overdue", "paid_on", "payment_reference", "attention_reason"] },
        ],
    },
    expenses: {
        section: "MONEY",
        grain: "One row per expense",
        who: "CEO, Admin",
        columnGroups: [
            {
                name: "Expense",
                keys: ["expense_date", "submitted_by", "department", "project_tag", "bucket", "category", "vendor", "description", "invoice_number", "amount", "currency", "original_amount", "source"],
            },
            { name: "Approval", keys: ["status", "approved_by", "approved_at", "rejection_reason", "attention_reason", "bill_url"] },
        ],
    },
    customer_loan_files: {
        section: "BATTERY FINANCE",
        grain: "One row per customer loan file",
        who: "CEO, Admin, Sales Head",
        columnGroups: [
            { name: "File", keys: ["file_id", "submitted_on", "dealer", "account_owner", "customer", "city", "kyc_status"] },
            { name: "Decision", keys: ["nbfc", "loan_file_number", "loan_status", "rejection_reason", "decided_on", "loan_amount", "disbursed_at", "disbursement_amount"] },
        ],
    },
    buyback: {
        section: "LIFECYCLE AND STOCK",
        grain: "One row per buyback request",
        who: "CEO, Admin, Sales Head, buyback team",
        columnGroups: [
            { name: "Request", keys: ["request_no", "dealer", "owner", "source_channel", "requested_on", "stage"] },
            {
                name: "Weight and money",
                keys: ["lines", "units", "kg", "missing_weight", "kg_picked_up", "picked_up_on", "vendor", "offer", "paid", "per_kg", "paid_on", "payment_reference"],
            },
        ],
    },
    inventory: {
        section: "LIFECYCLE AND STOCK",
        grain: "One row per battery or item",
        who: "CEO, Admin, Sales Head, inventory team",
        columnGroups: [
            { name: "Item", keys: ["id", "serial_number", "model_type", "asset_category", "asset_type", "quantity", "oem_name"] },
            {
                name: "Cost and status",
                keys: ["oem_invoice_number", "oem_invoice_date", "inventory_amount", "gst_amount", "with_gst", "status", "warehouse_location", "dealer", "received_date", "sold_at", "days_in_stock"],
            },
        ],
    },
};

/** The main sheet's columns in the layout's boxes; unlisted columns land in "Other", in sheet order. */
export function groupColumns(datasetId: string, columns: DatasetColumn[]): { name: string; columns: DatasetColumn[] }[] {
    const layout = DATASET_LAYOUT[datasetId];
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const used = new Set<string>();
    const out: { name: string; columns: DatasetColumn[] }[] = [];
    for (const g of layout?.columnGroups ?? []) {
        const cols = g.keys.map((k) => byKey.get(k)).filter((c): c is DatasetColumn => !!c && !used.has(c.key));
        cols.forEach((c) => used.add(c.key));
        if (cols.length) out.push({ name: g.name, columns: cols });
    }
    const rest = columns.filter((c) => !used.has(c.key));
    if (rest.length) out.push({ name: "Other", columns: rest });
    return out;
}
