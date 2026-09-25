// get_lead_details — one lead's picture (BRD §9.1, UC-08): contact, status,
// interest, owner, last 5 touchpoints and visits, CRM link.
//
// Scope first (out of scope ≡ not found), then the SAME bundle the Lead Detail
// screen reads (fetchLeadDetailBundle), then an ALLOWLIST projection — the
// bundle's commercials, onboarding and address history never leave here.
// Free text is scrubbed afterwards by the agent's sanitizeResult (Invariant 8).
// Also serves a tap on a list row (ast:lead:<id>), with no model involved.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchLeadDetailBundle } from "@/lib/inside-sales/leadDetail";
import type { ToolResult } from "../../types";
import { defineTool, LeadId, NOT_FOUND, scopedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";

export const HISTORY_ROWS = 5;

type VisitRow = {
    visit_status: string;
    visit_outcome: string | null;
    scheduled_date: string | null;
    actual_visit_date: string | null;
    visit_remarks: string | null;
    next_visit_date: string | null;
};

export const getLeadDetails: ToolFactory = () =>
    defineTool({
        name: "get_lead_details",
        kind: "read",
        description:
            "Show one lead the user can see: contact, status, interest, owner (and whether the user owns it), " +
            "the last 5 calls/notes and visits, and a CRM link.",
        schema: z.object({ lead_id: LeadId }),
        run: async (ctx, input): Promise<ToolResult> => {
            const scoped = await scopedLeadOr(ctx, input.lead_id);
            if (scoped.result) return scoped.result;

            const [bundle, visits] = await Promise.all([
                fetchLeadDetailBundle(scoped.lead.id),
                db.execute<VisitRow>(sql`
                    SELECT visit_status, visit_outcome, scheduled_date::text AS scheduled_date,
                           actual_visit_date::text AS actual_visit_date, visit_remarks,
                           next_visit_date::text AS next_visit_date
                      FROM lead_visits
                     WHERE dealer_lead_id = ${scoped.lead.id}
                     ORDER BY COALESCE(actual_visit_date, scheduled_date, created_at::date) DESC, created_at DESC
                     LIMIT ${HISTORY_ROWS}
                `),
            ]);
            // Deleted between the scope check and the read: same answer as never existing.
            if (!bundle) return NOT_FOUND;
            const l = bundle.lead;

            return {
                kind: "lead",
                lead: {
                    id: l.id,
                    shop_name: l.shop_name,
                    dealer_name: l.dealer_name,
                    phone: l.phone,
                    city: l.city,
                    state: l.state,
                    area: l.area,
                    status: l.lead_status,
                    interest: l.interest_level,
                    owner_name: l.current_owner_name,
                    owned_by_you: l.current_owner_id === ctx.user.id,
                    asm_name: l.asm_name,
                    next_follow_up_at: l.next_follow_up_at,
                    last_activity_at: l.last_touchpoint_at,
                    lost_reason: l.lost_reason,
                    recent_touchpoints: bundle.touchpoints.slice(0, HISTORY_ROWS).map((t) => ({
                        type: t.touchpoint_type,
                        at: t.performed_at,
                        by: t.performed_by_name,
                        call_status: t.call_status,
                        remarks: t.remarks,
                        next_action: t.next_action,
                        next_action_at: t.next_action_at,
                    })),
                    recent_visits: visits.map((v) => ({
                        status: v.visit_status,
                        outcome: v.visit_outcome,
                        scheduled_date: v.scheduled_date,
                        visited_on: v.actual_visit_date,
                        next_visit_date: v.next_visit_date,
                        remarks: v.visit_remarks,
                    })),
                    crm_url: leadUrl(ctx.user, l.id),
                },
            };
        },
    });
