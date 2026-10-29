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
// A "next visit" also inserts a SCHEDULED lead_visits row (BRD §2.3-2). Today's
// Schedule keys on a row with scheduled_date = today, so a date that only sat
// on the visited row's next_visit_date column never reached it.
//
// Ownership is the CALLER's job (assertOwner before calling), exactly as it was
// in the route: this function records, it does not authorise.
//
// ID 196: a done visit CLOSES the lead's booked visit instead of sitting next
// to it — the open scheduled / pending row (on or before the visit day) becomes
// the visit, and any older open ones are cancelled. Before, nothing ever closed
// a plan, so My day kept it as "Visit overdue" and the Planned counts grew.
// A verified visit (`capture`, E-363) takes its photo, location and date (the
// IST day the photo reached the server) from the capture.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { writeTouchpoint, type WriteTouchpointInput } from "@/lib/touchpoints/write";
import { ENGAGED_OUTCOMES, type VisitInput } from "@/lib/asm/types";
import { istDay } from "@/lib/visits/verifiedCapture";
import { applyCaptureToVisit, type VisitCapture } from "@/lib/visits/verifiedStore";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordVisitInput = VisitInput & {
    leadId: string;
    asmId: string;
    /** ID 196: the verified camera photo + live location (checked by the caller). */
    capture?: VisitCapture | null;
};

export type RecordVisitResult = {
    visitId: string | null;
    /** The scheduled next-visit row; null when none was needed or one already existed. */
    scheduledVisitId: string | null;
};

/** Visit states that still count as "planned" — what Today's Schedule shows. */
const OPEN_SCHEDULED_STATUSES = ["scheduled", "pending_scheduling"];

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

    // Only strictly AFTER the visit. An earlier date is a typo, and a past
    // "scheduled" row would sit in the planned-visit counts forever. The same
    // day is excluded too: the queue's latest-visit lateral orders by
    // COALESCE(actual_visit_date, scheduled_date), so a visited row and a
    // scheduled row on one date tie and Today's Schedule would show the lead or
    // not at random.
    const visitDate = visitRow.actual_visit_date ?? today;
    const scheduled =
        input.next_action === "next_visit" &&
        input.next_visit_date &&
        input.next_visit_date > visitDate
            ? {
                  leadId: input.leadId,
                  asmId: input.asmId,
                  date: input.next_visit_date,
                  remarks: `Next visit, scheduled from the visit on ${visitDate}`,
              }
            : null;

    return { visitRow, touchpoint, scheduled };
}

export type ScheduleVisitInput = {
    leadId: string;
    asmId: string;
    /** YYYY-MM-DD, an IST calendar day. */
    date: string;
    remarks: string;
};

/**
 * Put a visit on an ASM's schedule. Idempotent per (lead, ASM, date): an open
 * scheduled row for the same day is reused rather than duplicated, so logging
 * the same next visit twice does not double the planned-visit counts. Callers
 * on the Assistant path are serialised per user; two different users racing to
 * schedule the same lead on the same day could still both insert.
 */
export async function scheduleVisit(
    input: ScheduleVisitInput,
    opts?: { tx?: Tx },
): Promise<{ visitId: string | null }> {
    const run = async (tx: Tx) => {
        const existing = await tx
            .select({ visit_id: leadVisits.visit_id })
            .from(leadVisits)
            .where(
                and(
                    eq(leadVisits.dealer_lead_id, input.leadId),
                    eq(leadVisits.asm_id, input.asmId),
                    eq(leadVisits.scheduled_date, input.date),
                    inArray(leadVisits.visit_status, OPEN_SCHEDULED_STATUSES),
                ),
            )
            .limit(1);
        if (existing.length > 0) return { visitId: null };

        const inserted = await tx
            .insert(leadVisits)
            .values({
                dealer_lead_id: input.leadId,
                asm_id: input.asmId,
                scheduled_date: input.date,
                visit_status: "scheduled",
                visit_remarks: input.remarks,
            })
            .returning({ visit_id: leadVisits.visit_id });
        return { visitId: inserted[0]?.visit_id ?? null };
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}

export async function recordVisit(
    input: RecordVisitInput,
    opts?: { tx?: Tx },
): Promise<RecordVisitResult> {
    const today = istDay(new Date());
    const capture = input.capture ?? null;
    const plan = planVisit(
        capture
            ? {
                  ...input,
                  // The capture decides where and when — never the form.
                  actual_visit_date: istDay(new Date(capture.captured_at)),
                  photos: [capture.photo_url],
                  gps_check_in_lat: capture.gps_lat,
                  gps_check_in_lng: capture.gps_lng,
              }
            : input,
        today,
    );

    const run = async (tx: Tx): Promise<RecordVisitResult> => {
        const visitId =
            input.visit_status === "visited"
                ? await closeBookedVisit(tx, input.leadId, plan.visitRow)
                : null;
        const inserted = visitId
            ? [{ visit_id: visitId }]
            : await tx
                  .insert(leadVisits)
                  .values({ ...plan.visitRow, photos: plan.visitRow.photos as never })
                  .returning({ visit_id: leadVisits.visit_id });
        if (capture && inserted[0]?.visit_id) await applyCaptureToVisit(tx, inserted[0].visit_id, capture);
        await writeTouchpoint(plan.touchpoint, { tx });
        const scheduled = plan.scheduled
            ? await scheduleVisit(plan.scheduled, { tx })
            : { visitId: null };
        return { visitId: inserted[0]?.visit_id ?? null, scheduledVisitId: scheduled.visitId };
    };

    return opts?.tx ? run(opts.tx) : db.transaction(run);
}

/**
 * ID 196: a done visit takes over the lead's open booked visit (scheduled or
 * pending scheduling, booked for the visit day or earlier, or not yet dated)
 * — the newest one becomes the visit, keeping its planned date; any others
 * are cancelled. Returns the visit id, or null when nothing was booked (the
 * caller then inserts a fresh, unplanned visit row).
 */
async function closeBookedVisit(
    tx: Tx,
    leadId: string,
    row: ReturnType<typeof planVisit>["visitRow"],
): Promise<string | null> {
    const day = row.actual_visit_date;
    if (!day) return null;
    const open = (await tx.execute(sql`
        SELECT visit_id::text AS visit_id FROM lead_visits
         WHERE dealer_lead_id = ${leadId}
           AND visit_status IN ('scheduled', 'pending_scheduling')
           AND (scheduled_date IS NULL OR scheduled_date <= ${day}::date)
         ORDER BY scheduled_date DESC NULLS LAST, created_at DESC
         FOR UPDATE
    `)) as unknown as Array<{ visit_id: string }>;
    if (open.length === 0) return null;
    const [keep, ...rest] = open;
    await tx
        .update(leadVisits)
        .set({
            asm_id: row.asm_id,
            actual_visit_date: day,
            visit_status: row.visit_status,
            visit_outcome: row.visit_outcome,
            visit_remarks: row.visit_remarks,
            photos: row.photos as never,
            gps_check_in_lat: row.gps_check_in_lat,
            gps_check_in_lng: row.gps_check_in_lng,
            next_action: row.next_action,
            next_visit_date: row.next_visit_date,
            updated_at: new Date(),
        })
        .where(eq(leadVisits.visit_id, keep!.visit_id));
    if (rest.length > 0) {
        await tx
            .update(leadVisits)
            .set({
                visit_status: "cancelled",
                visit_remarks: sql`concat_ws(' · ', ${leadVisits.visit_remarks}, ${`Closed by the visit on ${day}`})`,
                updated_at: new Date(),
            })
            .where(inArray(leadVisits.visit_id, rest.map((r) => r.visit_id)));
    }
    return keep!.visit_id;
}
