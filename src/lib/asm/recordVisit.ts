// Log an ASM visit (BRD §0.8). Extracted from POST /api/asm/lead/[id]/visit so
// the screen and the WhatsApp Assistant write a visit exactly the same way.
//
// ONE transaction: the lead_visits row and its parallel `visit` touchpoint
// commit or roll back together. (The route used to commit the visit row first
// and write the touchpoint in a second transaction, so a touchpoint failure
// left a visit with no history entry.) Pass `opts.tx` to fold the visit into a
// larger atomic write — the Assistant's log_visit adds an interest change and
// an optional status change in the same transaction.
//
// Ownership is the CALLER's job (assertOwner before calling), exactly as it was
// in the route: this function records, it does not authorise.

import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { writeTouchpoint, type WriteTouchpointInput } from "@/lib/touchpoints/write";
import { ENGAGED_OUTCOMES, type VisitInput } from "@/lib/asm/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordVisitInput = VisitInput & { leadId: string; asmId: string };

export type RecordVisitResult = { visitId: string | null };

/**
 * What a visit writes — pure, so the mapping is unit-tested without a DB.
 * `today` is the YYYY-MM-DD used when a `visited` row carries no date.
 */
export function planVisit(input: RecordVisitInput, today: string) {
    const isEngaged = input.visit_outcome
        ? ENGAGED_OUTCOMES.includes(input.visit_outcome)
        : false;

    const visitRow = {
        dealer_lead_id: input.leadId,
        asm_id: input.asmId,
        scheduled_date: input.scheduled_date ?? null,
        actual_visit_date:
            input.actual_visit_date ?? (input.visit_status === "visited" ? today : null),
        visit_status: input.visit_status,
        visit_outcome: input.visit_outcome ?? null,
        visit_remarks: input.visit_remarks,
        photos: input.photos ?? [],
        gps_check_in_lat: input.gps_check_in_lat != null ? String(input.gps_check_in_lat) : null,
        gps_check_in_lng: input.gps_check_in_lng != null ? String(input.gps_check_in_lng) : null,
        next_action: input.next_action,
        next_visit_date: input.next_visit_date ?? null,
    };

    const touchpoint: WriteTouchpointInput = {
        dealerLeadId: input.leadId,
        touchpointType: "visit",
        performedBy: input.asmId,
        isEngaged,
        remarks:
            `${input.visit_status}` +
            (input.visit_outcome ? ` · ${input.visit_outcome}` : "") +
            `\n\n${input.visit_remarks}` +
            (input.next_action === "next_visit" && input.next_visit_date
                ? `\n\nNext visit: ${input.next_visit_date}`
                : ""),
        attachments: input.photos?.map((url) => ({ url, type: "photo" })) ?? null,
        nextAction:
            input.next_action === "next_visit"
                ? "follow_up"
                : input.next_action === "convert"
                    ? "mark_converted"
                    : input.next_action === "lost"
                        ? "mark_lost"
                        : null,
        nextActionAt: input.next_visit_date ? new Date(input.next_visit_date) : null,
    };

    return { visitRow, touchpoint };
}

export async function recordVisit(
    input: RecordVisitInput,
    opts?: { tx?: Tx },
): Promise<RecordVisitResult> {
    const plan = planVisit(input, new Date().toISOString().slice(0, 10));

    const run = async (tx: Tx): Promise<RecordVisitResult> => {
        const inserted = await tx
            .insert(leadVisits)
            .values({ ...plan.visitRow, photos: plan.visitRow.photos as never })
            .returning({ visit_id: leadVisits.visit_id });
        await writeTouchpoint(plan.touchpoint, { tx });
        return { visitId: inserted[0]?.visit_id ?? null };
    };

    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
