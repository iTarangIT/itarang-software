// POST /api/visits/capture — tracker ID 196 (PJP phase 1).
//
// The shop photo for a verified visit, taken with the camera from the visit
// form, with the phone's live location (multipart: photo, lat, lng,
// accuracy_m, and lead_id OR account_id). Refused without a location, with
// one worse than 100 m, without a photo, or with a photo already used. The
// server stamps location + its own time on the photo and keeps the record;
// the visit form then sends the returned capture_id with the visit.
//
// Who: the lead's owner; for an account (My Dealers), its owner or the
// owner's manager. The photo file's own GPS is never read.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { assertOwner } from "@/lib/leads/ownership";
import { getTeamMemberIds } from "@/lib/users/team";
import { checkVisitLocation, checkVisitPhoto, mayLogAccountVisit } from "@/lib/visits/verifiedCapture";
import { DuplicateVisitPhotoError, hasVerifiedVisits, saveVisitCapture } from "@/lib/visits/verifiedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: FormDataEntryValue | null): number | null => {
    if (v == null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    if (!(await hasVerifiedVisits())) {
        return errorResponse("Verified visits are not set up on this server yet (E-363).", 503);
    }
    const form = await req.formData().catch(() => null);
    if (!form) return errorResponse("Expected the photo and location as a form upload.", 400);

    const leadId = String(form.get("lead_id") ?? "").trim() || null;
    const accountId = String(form.get("account_id") ?? "").trim() || null;
    if (!leadId === !accountId) return errorResponse("Say which lead or which counter this visit is for.", 400);

    const lat = num(form.get("lat"));
    const lng = num(form.get("lng"));
    const accuracy = num(form.get("accuracy_m"));
    const loc = checkVisitLocation(lat, lng, accuracy);
    if (!loc.ok) return errorResponse(loc.message, 422);

    const photo = form.get("photo");
    const file = photo instanceof File ? photo : null;
    const pic = checkVisitPhoto(file ? { type: file.type || "image/jpeg", size: file.size } : null);
    if (!pic.ok || !file) return errorResponse(pic.ok ? "Take a photo of the shop with the camera." : pic.message, 422);

    if (leadId) {
        await assertOwner(leadId, user.id);
    } else {
        const rows = (await db.execute(sql`
            SELECT owner_user_id::text AS owner_id FROM account_ownership WHERE account_id = ${accountId}
        `)) as unknown as Array<{ owner_id: string | null }>;
        const ok = mayLogAccountVisit({
            userId: user.id,
            ownerId: rows[0]?.owner_id ?? null,
            teamIds: await getTeamMemberIds(user.id),
        });
        if (!ok) return errorResponse("Only this counter's owner, or their manager, can log a visit here.", 403);
    }

    try {
        const saved = await saveVisitCapture({
            userId: user.id,
            leadId,
            accountId,
            photo: Buffer.from(await file.arrayBuffer()),
            lat: lat!,
            lng: lng!,
            accuracyM: accuracy!,
        });
        return successResponse({
            capture_id: saved.id,
            photo_url: saved.photoUrl,
            captured_at: saved.capturedAt,
            accuracy_m: accuracy,
        });
    } catch (err) {
        if (err instanceof DuplicateVisitPhotoError) return errorResponse(err.message, 409);
        throw err;
    }
});
