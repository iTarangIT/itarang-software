// Module 3 — paginated raw-SQL builders for the three admin resolution queues:
// escalations (BRD §0.6), merge requests (BRD §0.4), onboarding dropouts
// (BRD §0.13 Point B). Raw SQL via db.execute() — same approach as the
// Module 1/2 query builders.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type {
    EscalationQueueRow,
    EscalationThreadBundle,
    MergeRequestRow,
    OnboardingDropoutRow,
} from "./types";
import type {
    LeadDetailStatusHistory,
    LeadDetailTouchpoint,
} from "@/lib/inside-sales/types";

import { users, dealerLeads, leadEscalations, leadTouchpoints, dealerLeadStatusHistory, duplicateMergeRequests, dealerOnboardingApplications } from "@/lib/db/schema";

type PageArgs = { page: number; limit: number; q?: string | null };

// ────────────────────────────── Escalations ───────────────────────────────

// Urgency rank for ORDER BY — urgent first, then high, then normal.
const URGENCY_RANK = sql.raw(
    `CASE e.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`,
);

function escalationWhere(status: "pending" | "resolved", q?: string | null) {
    const statusFilter =
        status === "pending"
            ? sql`e.status = 'pending_review'`
            : sql`e.status <> 'pending_review'`;
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"})`
        : sql``;
    return sql`${statusFilter}${search}`;
}

export async function fetchEscalationQueue(
    status: "pending" | "resolved",
    { page, limit, q }: PageArgs,
): Promise<{ rows: EscalationQueueRow[]; total: number }> {
    const where = escalationWhere(status, q);
    const offset = (page - 1) * limit;

    const rows = await db.execute<EscalationQueueRow>(sql`
        SELECT
            e.escalation_id,
            e.dealer_lead_id,
            dl.dealer_name,
            dl.phone,
            dl.city,
            e.escalation_reason,
            e.urgency,
            e.status,
            e.raised_by,
            ru.name AS raised_by_name,
            e.raised_at,
            e.resolved_at,
            e.resolution_action,
            (e.ceo_comment IS NOT NULL OR e.ceo_recommendation IS NOT NULL) AS has_ceo_input,
            dl.current_owner_id,
            ow.name AS current_owner_name
        FROM ${leadEscalations} e
        JOIN ${dealerLeads} dl ON dl.id = e.dealer_lead_id
        LEFT JOIN ${users} ru ON ru.id::text = e.raised_by
        LEFT JOIN ${users} ow ON ow.id::text = dl.current_owner_id
        WHERE ${where}
        ORDER BY ${URGENCY_RANK} ASC, e.raised_at ASC
        LIMIT ${limit} OFFSET ${offset}
    `);

    const countRows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c
        FROM ${leadEscalations} e
        JOIN ${dealerLeads} dl ON dl.id = e.dealer_lead_id
        WHERE ${where}
    `);

    return {
        rows: rows as unknown as EscalationQueueRow[],
        total: Number(countRows[0]?.c ?? 0),
    };
}

export async function fetchEscalationThread(
    escalationId: string,
): Promise<EscalationThreadBundle | null> {
    const escRows = await db.execute<EscalationThreadBundle["escalation"]>(sql`
        SELECT
            e.escalation_id,
            e.dealer_lead_id,
            e.escalation_reason,
            e.escalation_notes,
            e.suggested_action,
            e.urgency,
            e.status,
            e.raised_by,
            ru.name AS raised_by_name,
            e.raised_at,
            e.ceo_comment,
            e.ceo_recommendation,
            e.ceo_recommended_at,
            e.resolved_by,
            rv.name AS resolved_by_name,
            e.resolved_at,
            e.resolution_action,
            e.resolution_notes
        FROM ${leadEscalations} e
        LEFT JOIN ${users} ru ON ru.id::text = e.raised_by
        LEFT JOIN ${users} rv ON rv.id::text = e.resolved_by
        WHERE e.escalation_id = ${escalationId}
        LIMIT 1
    `);
    const escalation = escRows[0];
    if (!escalation) return null;

    const leadRows = await db.execute<EscalationThreadBundle["lead"]>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.lead_status,
            dl.current_owner_id,
            ow.name AS current_owner_name
        FROM ${dealerLeads} dl
        LEFT JOIN ${users} ow ON ow.id::text = dl.current_owner_id
        WHERE dl.id = ${escalation.dealer_lead_id}
        LIMIT 1
    `);

    const touchpoints = await db.execute<LeadDetailTouchpoint>(sql`
        SELECT
            t.touchpoint_id,
            t.touchpoint_type,
            t.performed_by,
            u.name AS performed_by_name,
            t.performed_at,
            t.call_status,
            t.call_duration_sec,
            t.is_engaged,
            t.remarks,
            t.attachments,
            t.next_action,
            t.next_action_at
        FROM ${leadTouchpoints} t
        LEFT JOIN ${users} u ON u.id::text = t.performed_by
        WHERE t.dealer_lead_id = ${escalation.dealer_lead_id}
        ORDER BY t.performed_at DESC
        LIMIT 100
    `);

    const statusHistory = await db.execute<LeadDetailStatusHistory>(sql`
        SELECT
            h.history_id,
            h.from_status,
            h.to_status,
            h.from_lost_reason,
            h.to_lost_reason,
            h.changed_by,
            u.name AS changed_by_name,
            h.changed_at,
            h.reason_notes
        FROM ${dealerLeadStatusHistory} h
        LEFT JOIN ${users} u ON u.id::text = h.changed_by
        WHERE h.dealer_lead_id = ${escalation.dealer_lead_id}
        ORDER BY h.changed_at DESC
    `);

    return {
        escalation,
        lead: leadRows[0] ?? {
            id: escalation.dealer_lead_id,
            dealer_name: null,
            phone: null,
            city: null,
            state: null,
            lead_status: null,
            current_owner_id: null,
            current_owner_name: null,
        },
        touchpoints: touchpoints as unknown as LeadDetailTouchpoint[],
        status_history: statusHistory as unknown as LeadDetailStatusHistory[],
    };
}

// ──────────────────────────── Merge requests ──────────────────────────────

export async function fetchMergeRequests(
    status: "pending" | "resolved",
    { page, limit, q }: PageArgs,
): Promise<{ rows: MergeRequestRow[]; total: number }> {
    const statusFilter =
        status === "pending"
            ? sql`m.status = 'pending'`
            : sql`m.status <> 'pending'`;
    const search = q
        ? sql` AND (tl.dealer_name ILIKE ${"%" + q + "%"} OR tl.phone ILIKE ${"%" + q + "%"})`
        : sql``;
    const where = sql`${statusFilter}${search}`;
    const offset = (page - 1) * limit;

    const rows = await db.execute<MergeRequestRow>(sql`
        SELECT
            m.id,
            m.request_type,
            m.source_lead_id,
            m.target_lead_id,
            tl.dealer_name AS target_dealer_name,
            tl.phone AS target_phone,
            sl.dealer_name AS source_dealer_name,
            m.requested_by,
            ru.name AS requested_by_name,
            m.request_notes,
            m.status,
            m.resolution_action,
            m.admin_resolution_notes,
            m.resolved_at,
            m.created_at
        FROM ${duplicateMergeRequests} m
        LEFT JOIN ${dealerLeads} tl ON tl.id = m.target_lead_id
        LEFT JOIN ${dealerLeads} sl ON sl.id = m.source_lead_id
        LEFT JOIN ${users} ru ON ru.id::text = m.requested_by
        WHERE ${where}
        ORDER BY m.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
    `);

    const countRows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c
        FROM ${duplicateMergeRequests} m
        LEFT JOIN ${dealerLeads} tl ON tl.id = m.target_lead_id
        WHERE ${where}
    `);

    return {
        rows: rows as unknown as MergeRequestRow[],
        total: Number(countRows[0]?.c ?? 0),
    };
}

// ───────────────────────── Onboarding dropouts ────────────────────────────

// BRD §0.13 Point B — a Converted lead is a "dropout pending review" when its
// onboarding application is rejected/withdrawn OR stalled (still in an early
// status with no action for 30+ calendar days), and admin has not yet acted
// (onboarding_dropout_reason still NULL).
export const DROPOUT_WHERE = sql`
    dl.lead_status = 'Converted'
    AND dl.is_active IS NOT FALSE
    AND dl.onboarding_dropout_reason IS NULL
    AND dl.dealer_onboarding_application_id IS NOT NULL
    AND (
        oa.onboarding_status IN ('rejected', 'withdrawn')
        OR (
            oa.onboarding_status IN ('draft', 'submitted', 'correction_requested')
            AND COALESCE(oa.last_action_at, oa.updated_at)
                < NOW() - INTERVAL '30 days'
        )
    )
`;

export async function countOnboardingDropouts(): Promise<number> {
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c
        FROM ${dealerLeads} dl
        JOIN ${dealerOnboardingApplications} oa
            ON oa.id = dl.dealer_onboarding_application_id
        WHERE ${DROPOUT_WHERE}
    `);
    return Number(rows[0]?.c ?? 0);
}

export async function fetchOnboardingDropouts({
    page,
    limit,
    q,
}: PageArgs): Promise<{ rows: OnboardingDropoutRow[]; total: number }> {
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"})`
        : sql``;
    const offset = (page - 1) * limit;

    const rows = await db.execute<OnboardingDropoutRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.closed_at,
            oa.id AS onboarding_application_id,
            oa.onboarding_status,
            COALESCE(oa.last_action_at, oa.updated_at) AS onboarding_last_action_at,
            CASE
                WHEN oa.onboarding_status = 'rejected' THEN 'rejected'
                WHEN oa.onboarding_status = 'withdrawn' THEN 'withdrawn'
                ELSE 'stalled'
            END AS dropout_kind,
            dl.current_owner_id,
            ow.name AS current_owner_name
        FROM ${dealerLeads} dl
        JOIN ${dealerOnboardingApplications} oa
            ON oa.id = dl.dealer_onboarding_application_id
        LEFT JOIN ${users} ow ON ow.id::text = dl.current_owner_id
        WHERE ${DROPOUT_WHERE}${search}
        ORDER BY dl.closed_at ASC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
    `);

    const countRows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c
        FROM ${dealerLeads} dl
        JOIN ${dealerOnboardingApplications} oa
            ON oa.id = dl.dealer_onboarding_application_id
        WHERE ${DROPOUT_WHERE}${search}
    `);

    return {
        rows: rows as unknown as OnboardingDropoutRow[],
        total: Number(countRows[0]?.c ?? 0),
    };
}
