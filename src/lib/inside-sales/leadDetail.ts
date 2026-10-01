// The Lead Detail bundle: lead row + current commercials + commercials
// history + touchpoint history (last 100) + status history + the latest AI
// campaign. Extracted from GET /api/inside-sales/lead/[id] so the WhatsApp
// Assistant's get_lead_details reads the same picture the screen shows.
//
// Not scope-checked — callers are. The route is role-gated; the Assistant
// checks the user's scope predicate first and then projects an allowlist.

import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { quotePriceChanged } from "@/lib/leads/oemPricing";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
import type {
    LeadDetailBundle,
    LeadDetailCommercials,
    LeadOnboardingMilestones,
    LeadDetailLead,
    LeadDetailStatusHistory,
    LeadDetailTouchpoint,
} from "@/lib/inside-sales/types";

/** null when the lead does not exist. */
export async function fetchLeadDetailBundle(leadId: string): Promise<LeadDetailBundle | null> {
    const leadRows = await db.execute<LeadDetailLead>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.area,
            dl.pincode,
            dl.timezone,
            dl.language,
            dl.final_intent_score,
            dl.lead_status,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            dl.last_touchpoint_at,
            dl.last_worked_at,
            dl.next_follow_up_at,
            dl.total_attempts,
            dl.assigned_at,
            dl.created_at,
            dl.updated_at,
            dl.overall_summary,
            dl.ai_session_id,
            dl.originator_id,
            originator.name AS originator_name,
            dl.closing_owner_id,
            closer.name AS closing_owner_name,
            dl.closing_role,
            dl.asm_id,
            asm.name AS asm_name,
            dl.closed_at,
            dl.pre_transfer_status,
            dl.lost_reason,
            dl.lost_reason_notes,
            dl.previous_lost_reason,
            dl.onboarding_dropout_reason,
            dl.onboarding_dropout_notes,
            dl.escalation_status,
            COALESCE(dl.escalation_count, 0) AS escalation_count,
            dl.last_escalation_id,
            dl.preliminary_payment_intent,
            COALESCE(dl.segments, '[]'::jsonb) AS segments,
            COALESCE(dl.address_history, '[]'::jsonb) AS address_history,
            dl.address_notes,
            dl.brochure_sent_at,
            dl.dealer_onboarding_application_id,
            app.onboarding_status AS onboarding_status,
            app.created_at AS onboarding_created_at,
            -- E-224's column, read through to_jsonb so a database without
            -- the migration returns null rather than failing this whole
            -- statement at parse time. See queryBuilder.ts.
            to_jsonb(dl) ->> 'neodove_sync_status' AS neodove_sync_status,
            -- E-296 "Type of Business", same to_jsonb guard: NULL on a
            -- database without the migration, which renders "Not set".
            to_jsonb(dl) ->> 'business_type' AS business_type,
            -- ID 81 (E-314) source tags, same to_jsonb guard.
            to_jsonb(dl) ->> 'source_door' AS source_door,
            to_jsonb(dl) ->> 'source_origin' AS source_origin,
            to_jsonb(dl) ->> 'acquisition_campaign_id' AS acquisition_campaign_id,
            -- ID 74 (E-314) Mark Won stamp and its flag, same to_jsonb guard.
            to_jsonb(dl) ->> 'won_at' AS won_at,
            (to_jsonb(dl) ->> 'won_without_approved_quote')::boolean AS won_without_approved_quote
        FROM dealer_leads dl
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        LEFT JOIN users originator ON originator.id::text = dl.originator_id
        LEFT JOIN users closer ON closer.id::text = dl.closing_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        LEFT JOIN dealer_onboarding_applications app ON app.id = dl.dealer_onboarding_application_id
        WHERE dl.id = ${leadId}
        LIMIT 1
    `);
    const lead = leadRows[0];
    if (!lead) return null;

    const [commercialsHistory, touchpoints, statusHistory] = await Promise.all([
        db.execute<LeadDetailCommercials>(sql`
            SELECT
                commercial_id, version_no, is_current, event_type,
                price_quoted::text, quote_document_url, brochure_url, brochure_sent_at,
                credit_terms, delivery_terms, warranty_terms,
                final_price::text, payment_method, deal_notes,
                COALESCE(product_lines, '[]'::jsonb) AS product_lines, notes,
                created_by, created_at, withdrawn_at,
                -- E-221/E-226 approval state. Selected since E-242: the rep
                -- raising a quote could previously never see what happened
                -- to it — the columns existed and this projection omitted
                -- them, so rejection_reason in particular was written by the
                -- CEO and read by nothing.
                approval_status, approval_mode, approved_at, rejection_reason,
                -- E-242 generated draft.
                quote_number, quote_pdf_url, quote_pdf_generated_at, quote_pdf_error,
                -- E-243 the dealer's own answer.
                dealer_decision, dealer_decision_at, dealer_decision_via,
                dealer_decision_note, oem_evaluation,
                -- ID 78 (E-314), read through to_jsonb so a DB without it still loads.
                to_jsonb(dealer_lead_commercials) ->> 'withdraw_reason' AS withdraw_reason
            FROM dealer_lead_commercials
            WHERE dealer_lead_id = ${leadId}
            ORDER BY version_no DESC
        `),
        db.execute<LeadDetailTouchpoint>(sql`
            SELECT
                t.touchpoint_id, t.touchpoint_type, t.performed_by,
                u.name AS performed_by_name,
                t.performed_at, t.call_status, t.call_duration_sec, t.is_engaged,
                t.remarks, COALESCE(t.attachments, '[]'::jsonb) AS attachments,
                t.next_action, t.next_action_at
            FROM lead_touchpoints t
            LEFT JOIN users u ON u.id::text = t.performed_by
            WHERE t.dealer_lead_id = ${leadId}
            ORDER BY t.performed_at DESC
            LIMIT 100
        `),
        db.execute<LeadDetailStatusHistory>(sql`
            SELECT
                h.history_id, h.from_status, h.to_status,
                h.from_lost_reason, h.to_lost_reason,
                h.changed_by, u.name AS changed_by_name,
                h.changed_at, h.reason_notes
            FROM dealer_lead_status_history h
            LEFT JOIN users u ON u.id::text = h.changed_by
            WHERE h.dealer_lead_id = ${leadId}
            ORDER BY h.changed_at DESC
            LIMIT 100
        `),
    ]);

    // Same "sent by …" stamp the queue row carries, so a lead does not lose
    // who sent it by being opened — the same reason NeodoveTag is repeated
    // in the detail header.
    const assignedBy = await fetchAssignedByForLeads([leadId]);

    // Any campaign this lead has been dialled in, newest first. The AI Call
    // History tab needs one only as a route parameter: the transcript
    // endpoint it calls returns every attempt ACROSS all campaigns for the
    // lead, so which campaign we hand it does not change the answer. Null
    // when the lead was never dialled — the tab renders its empty state.
    // Covered by idx_dialer_campaign_leads_lead_status.
    const campaignRows = await db.execute<{ campaign_id: string }>(sql`
        SELECT campaign_id
        FROM dialer_campaign_leads
        WHERE lead_id = ${leadId}
        ORDER BY started_at DESC NULLS LAST
        LIMIT 1
    `);

    // ID 78: flag an OPEN quote (released, unanswered, not withdrawn) whose
    // product reference price changed since it was issued.
    const history = commercialsHistory as LeadDetailCommercials[];
    for (const c of history) {
        const open =
            (c.event_type === "quote_issue" || c.event_type === "quote_revision") &&
            c.approval_status === "approved" &&
            !c.dealer_decision &&
            !c.withdrawn_at;
        if (!open || !c.product_lines?.length) continue;
        try {
            const live = await loadLiveOemPrices(c.product_lines);
            c.price_changed_since_issue = quotePriceChanged(c.oem_evaluation ?? null, live);
        } catch {
            c.price_changed_since_issue = false;
        }
    }

    // ID 84: onboarding milestones on the lead.
    const onboardingRows = (await db.execute<LeadOnboardingMilestones>(sql`
        SELECT oa.id::text AS application_id, oa.onboarding_status,
               oa.submitted_at::text AS docs_submitted_at, oa.agreement_status,
               oa.approved_at::text AS approved_at,
               COALESCE(oa.last_action_at, oa.updated_at)::text AS last_activity_at,
               (oa.onboarding_status NOT IN ('approved', 'rejected')
                AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '14 days') AS stalled
          FROM dealer_onboarding_applications oa
          JOIN dealer_leads dl ON dl.id = ${leadId}
         WHERE oa.id = dl.dealer_onboarding_application_id
            OR oa.originating_dealer_lead_id = ${leadId}
         ORDER BY oa.created_at DESC
         LIMIT 1
    `)) as unknown as LeadOnboardingMilestones[];

    const bundle: LeadDetailBundle = {
        lead: { ...(lead as LeadDetailLead), assigned_by: assignedBy[leadId] ?? null },
        latest_campaign_id: campaignRows[0]?.campaign_id ?? null,
        current_commercials:
            (commercialsHistory as LeadDetailCommercials[]).find((c) => c.is_current) ?? null,
        commercials_history: commercialsHistory as LeadDetailCommercials[],
        touchpoints: touchpoints as LeadDetailTouchpoint[],
        status_history: statusHistory as LeadDetailStatusHistory[],
        onboarding: onboardingRows[0] ?? null,
    };
    return bundle;
}
