// One-off, read-only (ID 246 test cases 1 and 2): runs the lead page's own loader and
// Next step rule (same inputs as LeadNextStepBox) on real sandbox leads.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchLeadDetailBundle } from "@/lib/inside-sales/leadDetail";
import { hasApprovedQuote } from "@/lib/inside-sales/types";
import { pickPendingQuote } from "@/lib/leads/liveQuote";
import { lostReasonWords } from "@/lib/leads/lostReasons";
import { handoverNoteInWords, istDay, nextStepFor } from "@/lib/leads/leadPage246";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

const NOTE_TYPES = new Set(["visit", "inside_sales_call", "whatsapp", "ai_call"]);

async function show(leadId: string, view: "asm" | "isr") {
    const bundle = await fetchLeadDetailBundle(leadId);
    if (!bundle) return console.log(leadId, "not found");
    const lead = bundle.lead;
    const ob = bundle.onboarding ?? null;
    const applicationId = lead.dealer_onboarding_application_id ?? null;
    const onboardingStatus = (lead.onboarding_status ?? ob?.onboarding_status ?? "draft").toLowerCase();
    const lastNote = bundle.touchpoints.find((t) => NOTE_TYPES.has(t.touchpoint_type) && t.remarks?.trim())?.remarks ?? null;
    const step = nextStepFor({
        view,
        status: lead.lead_status as LeadStatus | null,
        todayIst: istDay(new Date()) ?? "",
        nextBookingDate: lead.next_booking_date ?? null,
        hasOpenBooking: Boolean(lead.has_open_booking),
        nextBookingOverdueDays: lead.next_booking_overdue_days ?? null,
        nextBookingBookedAt: lead.next_booking_booked_at ?? null,
        nextFollowUpAt: lead.next_follow_up_at,
        lastNote,
        onboarding: applicationId
            ? {
                  applicationId,
                  status: onboardingStatus,
                  createdAt: lead.onboarding_created_at,
                  agreementLabel: ob?.agreement_outcome_label ?? (ob?.agreement_status ? ob.agreement_status.replace(/_/g, " ") : null),
                  approved: Boolean(ob?.approved_at),
                  stalled: Boolean(ob?.stalled),
              }
            : null,
        hasApprovedQuote: hasApprovedQuote(bundle.commercials_history),
        hasPendingQuote: pickPendingQuote(bundle.commercials_history) !== null,
        lostReasonWords: lead.lost_reason ? lostReasonWords(lead.lost_reason) : null,
    });
    const handover = bundle.touchpoints.find((t) => t.touchpoint_type === "asm_transfer" && t.remarks);
    console.log(`\n${lead.shop_name || lead.dealer_name} (${leadId}) · ${lead.lead_status} · view ${view}`);
    console.log(`  Next step: ${step.title}`);
    console.log(`  Buttons:   ${step.actions.join(", ") || "(none)"}`);
    console.log(`  Mark Won offered by the box: ${step.actions.includes("mark_won" as never)}`);
    if (handover) console.log(`  Hand-over note raw:   ${handover.remarks!.slice(0, 120).replace(/\n/g, " ")}\n  Hand-over note words: ${handoverNoteInWords(handover.remarks).slice(0, 160).replace(/\n/g, " ")}`);
}

async function main() {
    await show("DL-1781512894586-yNICekRI", "isr"); // Test Shop: Won, onboarding draft
    const [od] = (await db.execute(sql`
        SELECT dl.id FROM dealer_leads dl
          JOIN LATERAL (SELECT b.scheduled_date FROM lead_visits b WHERE b.dealer_lead_id = dl.id
                          AND b.visit_status IN ('scheduled','pending_scheduling') ORDER BY b.created_at DESC LIMIT 1) nb ON TRUE
          JOIN users u ON u.id::text = dl.current_owner_id AND u.role = 'asm'
         WHERE nb.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
           AND dl.lead_status NOT IN ('Won','Lost','Converted')
         ORDER BY nb.scheduled_date DESC LIMIT 1`)) as unknown as Array<{ id: string }>;
    if (od) await show(od.id, "asm");
    const [tr] = (await db.execute(sql`
        SELECT t.dealer_lead_id AS id FROM lead_touchpoints t
         WHERE t.touchpoint_type = 'asm_transfer' AND t.remarks ~ '[A-Z][a-z]+_[A-Z]' ORDER BY t.performed_at DESC LIMIT 1`)) as unknown as Array<{ id: string }>;
    if (tr) await show(tr.id, "asm");
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
