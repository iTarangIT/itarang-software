// POST /api/visits/account — tracker ID 196: a verified visit on an existing
// counter (My Dealers > account > Log visit, or the WhatsApp link).
//
// Body: { account_id, capture_id, visit_outcome, visit_remarks }. The capture
// (POST /api/visits/capture) carries the stamped photo, the live location and
// the day. Its owner, or the owner's manager, may log. The visit is a
// lead_visits row with account_id; when the account came through a lead it is
// also filed on that lead (dealer_lead_id + a visit touchpoint) so the lead's
// history shows it. No lead status changes here — the account is past that.

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

export const dynamic = "force-dynamic";

const Body = z.object({
    account_id: z.string().min(1).max(255),
    capture_id: z.string().uuid(),
    visit_outcome: z.enum(VISIT_OUTCOME),
    visit_remarks: z.string().trim().min(1).max(5000),
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

    const visitId = await db.transaction(async (tx) => {
        const capture = await loadVisitCapture(body.capture_id, tx);
        if (!capture) throw new CaptureError("That shop photo was not found. Take it again.");
        const use = checkCaptureUse(capture, { userId: user.id, accountId: body.account_id, now: new Date() });
        if (!use.ok) throw new CaptureError(use.message);

        const day = istDay(new Date(capture.captured_at));
        const [row] = (await tx.execute(sql`
            INSERT INTO lead_visits
                (dealer_lead_id, account_id, asm_id, actual_visit_date, visit_status, visit_outcome,
                 visit_remarks, photos, gps_check_in_lat, gps_check_in_lng)
            VALUES (${leadId}, ${body.account_id}, ${user.id}, ${day}::date, 'visited', ${body.visit_outcome},
                    ${body.visit_remarks}, ${JSON.stringify([capture.photo_url])}::jsonb,
                    ${capture.gps_lat}, ${capture.gps_lng})
            RETURNING visit_id::text AS visit_id
        `)) as unknown as Array<{ visit_id: string }>;
        await applyCaptureToVisit(tx, row!.visit_id, capture);
        if (leadId) {
            await writeTouchpoint(
                {
                    dealerLeadId: leadId,
                    touchpointType: "visit",
                    performedBy: user.id,
                    isEngaged: ENGAGED_OUTCOMES.includes(body.visit_outcome),
                    remarks: `visited · ${body.visit_outcome} (counter visit)\n\n${body.visit_remarks}`,
                    attachments: [{ url: capture.photo_url, type: "photo" }],
                    nextAction: null,
                    nextActionAt: null,
                },
                { tx },
            );
        }
        return row!.visit_id;
    });

    return successResponse({ visit_id: visitId });
});
