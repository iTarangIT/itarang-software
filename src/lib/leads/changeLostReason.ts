// Change Lost reason (tracker ID 136, decided 3 Oct 2026) — what the Sales Head
// and admin get instead of "Correct status" for a Lost lead recorded with the
// wrong reason.
//
//   * Lost leads only. The lead stays Lost: status, closed date and closing
//     owner do not change.
//   * The same reason list as Mark Lost (onboarding_dropout stays with the
//     admin drop-out review); a competitor name for "Lost to competition".
//   * A note is required.
//   * History: one dealer_lead_status_history row Lost → Lost carrying
//     from_lost_reason → to_lost_reason (no status counter reads a Lost → Lost
//     row), plus a status_change_note touchpoint on the timeline. Not work: the
//     idle clock does not move.
//   * Lost-by-reason reports read dealer_leads.lost_reason, so they use the new
//     reason from the moment it is saved.
//
// A wrong Lost (the dealer is still in play) is Reactivate, not this.

import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { dealerLeadStatusHistory, leadTouchpoints } from "@/lib/db/schema";
import type { LostReason } from "@/lib/lifecycle/transitions";
import { withLeadActor } from "@/lib/leads/actorContext";
import { LostReasonChangeError, planLostReasonChange } from "@/lib/leads/changeLostReasonRules";

export {
    CHANGEABLE_LOST_REASONS,
    LOST_REASON_CHANGE_ROLES,
    LostReasonChangeError,
    planLostReasonChange,
} from "@/lib/leads/changeLostReasonRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function changeLostReason(input: {
    leadId: string;
    actor: { id: string; role: string };
    to: LostReason;
    competitorName?: string | null;
    note?: string | null;
}, opts?: { tx?: Tx }): Promise<{ historyId: string | null; from: LostReason | null; to: LostReason }> {
    // With `tx` the caller has set app.actor_id (the verify script does).
    const run = async (tx: Tx) => {
        const rows = (await tx.execute<{
            lead_status: string | null;
            lost_reason: string | null;
            competitor_name: string | null;
        }>(sql`
            SELECT lead_status, lost_reason, to_jsonb(dealer_leads) ->> 'competitor_name' AS competitor_name
              FROM dealer_leads WHERE id = ${input.leadId}
             FOR UPDATE
        `)) as unknown as Array<{ lead_status: string | null; lost_reason: string | null; competitor_name: string | null }>;
        const lead = rows[0];
        if (!lead) throw new LostReasonChangeError("Lead not found", 404);

        const plan = planLostReasonChange({
            leadStatus: lead.lead_status,
            currentReason: lead.lost_reason,
            currentCompetitor: lead.competitor_name,
            to: input.to,
            competitorName: input.competitorName,
            note: input.note,
        });
        const now = new Date();

        // The reason, and what Mark Lost records with it: the competitor (ID 76,
        // cleared when the reason is no longer competition) and the AI-dialer
        // exclusion for business_closed (BRD §0.7) — lifted again when the
        // reason moves off business_closed, as Reactivate does.
        await tx.execute(sql`
            UPDATE dealer_leads
               SET lost_reason = ${plan.to},
                   ai_recall_status = CASE
                       WHEN ${plan.to}::text = 'business_closed' THEN 'excluded'
                       WHEN ${plan.from}::text = 'business_closed' AND ai_recall_status = 'excluded' THEN NULL
                       ELSE ai_recall_status END,
                   updated_at = NOW()
             WHERE id = ${input.leadId}
        `);
        if (plan.competitorName !== null || lead.competitor_name !== null) {
            await tx.execute(sql`
                UPDATE dealer_leads SET competitor_name = ${plan.competitorName}::text WHERE id = ${input.leadId}
            `);
        }

        const who = input.actor.role === "sales_head" ? "Sales Head" : "admin";
        const fromLabel = (plan.from ?? "none").replace(/_/g, " ");
        const toLabel = `${plan.to.replace(/_/g, " ")}${plan.competitorName ? ` (${plan.competitorName})` : ""}`;

        const [history] = await tx
            .insert(dealerLeadStatusHistory)
            .values({
                dealer_lead_id: input.leadId,
                from_status: "Lost",
                to_status: "Lost",
                from_lost_reason: plan.from,
                to_lost_reason: plan.to,
                changed_by: input.actor.id,
                changed_at: now,
                reason_notes: `Lost reason changed: ${plan.note}`,
            })
            .returning({ history_id: dealerLeadStatusHistory.history_id });

        // Timeline entry. Not work — last_touchpoint_at moves, last_worked_at does not.
        await tx.insert(leadTouchpoints).values({
            dealer_lead_id: input.leadId,
            touchpoint_type: "status_change_note",
            performed_by: input.actor.id,
            performed_at: now,
            remarks: `Lost reason changed by ${who}: ${fromLabel} → ${toLabel} — ${plan.note}`,
            attachments: [] as never,
            sync_method: "manual",
        });
        await tx.execute(sql`
            UPDATE dealer_leads SET last_touchpoint_at = ${now.toISOString()}::timestamptz WHERE id = ${input.leadId}
        `);

        return { historyId: history?.history_id ?? null, from: plan.from, to: plan.to };
    };
    return opts?.tx ? run(opts.tx) : withLeadActor(input.actor.id, run);
}
