// POST /api/visits/account — tracker ID 196: a verified visit on an existing
// counter (My Dealers > account > Log visit, or the WhatsApp link).
//
// Body: { account_id, capture_id, visit_outcome, visit_remarks }. The capture
// (POST /api/visits/capture) carries the stamped photo, the live location and
// the day. Its owner, or the owner's manager, may log. The visit is a
// lead_visits row with account_id; when the account came through a lead it is
// also filed on that lead (dealer_lead_id + a visit touchpoint) so the lead's
// history shows it. No lead status changes here — the account is past that.
//
// ID 241-2 (E-386, agreed 11 Nov): when E-386 is on, the body also carries
// dealer_outcome (Order taken, Payment collected, …), reported_amount (what the
// dealer MENTIONED — never revenue) and next_visit_date, required unless
// no_follow_up. The visit takes over the account's open booking dated on or
// before today; the next date is booked as a 'scheduled' row for the person
// logging, so it shows in My visits. visit_outcome is still written (from the
// dealer outcome) so the Sales Head's visit numbers count it as before.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { getTeamMemberIds } from "@/lib/users/team";
import { VISIT_OUTCOME, ENGAGED_OUTCOMES } from "@/lib/asm/types";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { checkCaptureUse, istDay, mayLogAccountVisit } from "@/lib/visits/verifiedCapture";
import { applyCaptureToVisit, hasVerifiedVisits, loadVisitCapture } from "@/lib/visits/verifiedStore";
import {
    DEALER_VISIT_OUTCOME_LABELS,
    dealerVisitProblem,
    isDealerVisitOutcome,
    leadOutcomeFor,
} from "@/lib/visits/dealerVisitOutcomes";
import {
    bookAccountVisit,
    hasDealerVisitOutcomes,
    setDealerVisitFields,
    takeOverAccountBooking,
} from "@/lib/visits/dealerVisitStore";

export const dynamic = "force-dynamic";

const Body = z.object({
    account_id: z.string().min(1).max(255),
    capture_id: z.string().uuid(),
    // Before E-386: the lead outcome list. With it: derived from dealer_outcome when absent.
    visit_outcome: z.enum(VISIT_OUTCOME).optional(),
    visit_remarks: z.string().trim().min(1).max(5000),
    dealer_outcome: z.string().max(30).nullish(),
    reported_amount: z.number().nullish(),
    next_visit_date: z.string().max(10).nullish(),
    no_follow_up: z.boolean().nullish(),
});

class CaptureError extends Error {
    readonly status = 422;
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    if (!(await hasVerifiedVisits())) {
        return errorResponse("Verified visits are not set up on this server yet (E-363).", 503);
    }
    const body = Body.parse(await req.json());

    const [acct] = (await db.execute(sql`
        SELECT ao.owner_user_id::text AS owner_id, ao.source_dealer_lead_id AS lead_id
          FROM account_ownership ao WHERE ao.account_id = ${body.account_id}
    `)) as unknown as Array<{ owner_id: string | null; lead_id: string | null }>;
    if (!mayLogAccountVisit({ userId: user.id, ownerId: acct?.owner_id, teamIds: await getTeamMemberIds(user.id) })) {
        return errorResponse("Only this counter's owner, or their manager, can log a visit here.", 403);
    }
    const leadId = acct?.lead_id ?? null;

    // ID 241-2: the dealer outcome and next visit, when E-386 is on this database.
    const outcomesOn = await hasDealerVisitOutcomes();
    if (outcomesOn) {
        const problem = dealerVisitProblem(
            {
                dealerOutcome: body.dealer_outcome,
                reportedAmount: body.reported_amount ?? null,
                nextVisitDate: body.next_visit_date || null,
                noFollowUp: body.no_follow_up ?? false,
            },
            istDay(new Date()),
        );
        if (problem) return errorResponse(problem, 422);
    } else if (!body.visit_outcome) {
        return errorResponse("Pick the visit outcome.", 422);
    }
    const dealerOutcome = outcomesOn && isDealerVisitOutcome(body.dealer_outcome) ? body.dealer_outcome : null;
    const visitOutcome = body.visit_outcome ?? (dealerOutcome ? leadOutcomeFor(dealerOutcome) : "other");
    const nextDate = outcomesOn && !body.no_follow_up ? body.next_visit_date || null : null;

    const visitId = await db.transaction(async (tx) => {
        const capture = await loadVisitCapture(body.capture_id, tx);
        if (!capture) throw new CaptureError("That shop photo was not found. Take it again.");
        const use = checkCaptureUse(capture, { userId: user.id, accountId: body.account_id, now: new Date() });
        if (!use.ok) throw new CaptureError(use.message);

        const day = istDay(new Date(capture.captured_at));
        const photoJson = JSON.stringify([capture.photo_url]);
        // ID 241-2: the visit takes over the account's open booking (keeps its planned date).
        const bookedId = outcomesOn ? await takeOverAccountBooking(tx, body.account_id, day) : null;
        const [row] = bookedId
            ? ((await tx.execute(sql`
                UPDATE lead_visits
                   SET dealer_lead_id = ${leadId}, asm_id = ${user.id}, actual_visit_date = ${day}::date,
                       visit_status = 'visited', visit_outcome = ${visitOutcome}, visit_remarks = ${body.visit_remarks},
                       photos = ${photoJson}::jsonb,
                       gps_check_in_lat = ${capture.gps_lat}, gps_check_in_lng = ${capture.gps_lng}, updated_at = NOW()
                 WHERE visit_id::text = ${bookedId}
                RETURNING visit_id::text AS visit_id
            `)) as unknown as Array<{ visit_id: string }>)
            : ((await tx.execute(sql`
                INSERT INTO lead_visits
                    (dealer_lead_id, account_id, asm_id, actual_visit_date, visit_status, visit_outcome,
                     visit_remarks, photos, gps_check_in_lat, gps_check_in_lng)
                VALUES (${leadId}, ${body.account_id}, ${user.id}, ${day}::date, 'visited', ${visitOutcome},
                        ${body.visit_remarks}, ${photoJson}::jsonb,
                        ${capture.gps_lat}, ${capture.gps_lng})
                RETURNING visit_id::text AS visit_id
            `)) as unknown as Array<{ visit_id: string }>);
        await applyCaptureToVisit(tx, row!.visit_id, capture);
        if (dealerOutcome) {
            await setDealerVisitFields(tx, row!.visit_id, {
                dealerOutcome,
                reportedAmount: body.reported_amount ?? null,
                nextVisitDate: nextDate,
                noFollowUp: Boolean(body.no_follow_up),
            });
            if (nextDate) await bookAccountVisit(tx, body.account_id, user.id, nextDate);
        }
        if (leadId) {
            const said = dealerOutcome ? DEALER_VISIT_OUTCOME_LABELS[dealerOutcome] : visitOutcome;
            await writeTouchpoint(
                {
                    dealerLeadId: leadId,
                    touchpointType: "visit",
                    performedBy: user.id,
                    isEngaged: ENGAGED_OUTCOMES.includes(visitOutcome),
                    remarks: `visited · ${said} (counter visit)\n\n${body.visit_remarks}`,
                    attachments: [{ url: capture.photo_url, type: "photo" }],
                    nextAction: null,
                    nextActionAt: null,
                },
                { tx },
            );
        }
        return row!.visit_id;
    });

    return successResponse({ visit_id: visitId, next_visit_date: nextDate });
});
