/**
 * Tracker ID 196 (PJP phase 1) — the rules for a VERIFIED visit. CLIENT-SAFE,
 * pure (no db import): the visit form checks the same thing before it uploads
 * that the server checks when the photo arrives.
 *
 * A visit counts only with the phone's live location, 100 m or better, and a
 * shop photo taken with the camera from the form. The server stamps location
 * and time on the photo; the photo file's own GPS is never trusted (phones and
 * WhatsApp strip it). Visit date = the IST day the photo reached the server —
 * no back-dating. Storage side: ./verifiedStore.ts.
 */

/** The worst location accuracy (metres) a verified visit accepts. */
export const MAX_VISIT_ACCURACY_M = 100;

/** Largest photo the capture accepts (bytes). */
export const MAX_VISIT_PHOTO_BYTES = 15 * 1024 * 1024;

export const VISIT_PHOTO_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

export type CaptureCheck = { ok: true } | { ok: false; message: string };

/** The location half: present, on Earth, and accurate enough. */
export function checkVisitLocation(
    lat: number | null | undefined,
    lng: number | null | undefined,
    accuracyM: number | null | undefined,
): CaptureCheck {
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, message: "Turn on location: a visit needs the phone's live location." };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
        return { ok: false, message: "That location could not be read. Turn location on and try again." };
    }
    if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= 0) {
        return { ok: false, message: "Turn on location: the phone did not say how accurate the location is." };
    }
    if (accuracyM > MAX_VISIT_ACCURACY_M) {
        return {
            ok: false,
            message:
                `Your location is not within ${MAX_VISIT_ACCURACY_M} m. The phone can only place you within ` +
                `${Math.round(accuracyM)} m, and a visit needs ${MAX_VISIT_ACCURACY_M} m or less. Turn on GPS ` +
                `(precise location), step outside or near a window, wait a few seconds, then tap "Read location again".`,
        };
    }
    return { ok: true };
}

/** The photo half: a camera image of a sensible size. */
export function checkVisitPhoto(photo: { type: string; size: number } | null | undefined): CaptureCheck {
    if (!photo || photo.size <= 0) return { ok: false, message: "Take a photo of the shop with the camera." };
    if (!(VISIT_PHOTO_TYPES as readonly string[]).includes(photo.type.toLowerCase())) {
        return { ok: false, message: "The shop photo must be a camera picture (JPG, PNG, WEBP or HEIC)." };
    }
    if (photo.size > MAX_VISIT_PHOTO_BYTES) return { ok: false, message: "That photo is too large (15 MB at most)." };
    return { ok: true };
}

/** The IST calendar day (YYYY-MM-DD) of an instant. */
export function istDay(at: Date): string {
    return new Date(at.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * May this capture be used for a visit now? Only by the person who took it,
 * for the same lead / account, on the same IST day, and only once.
 */
export function checkCaptureUse(
    capture: {
        user_id: string;
        dealer_lead_id: string | null;
        account_id: string | null;
        captured_at: Date | string;
        visit_id: string | null;
    },
    use: { userId: string; leadId?: string | null; accountId?: string | null; now: Date },
): CaptureCheck {
    if (capture.user_id !== use.userId) return { ok: false, message: "That photo was taken by someone else." };
    if (capture.visit_id) return { ok: false, message: "That photo is already used on another visit. Take a new one." };
    if (use.leadId && capture.dealer_lead_id !== use.leadId) {
        return { ok: false, message: "That photo was taken for a different lead." };
    }
    if (use.accountId && capture.account_id !== use.accountId) {
        return { ok: false, message: "That photo was taken for a different counter." };
    }
    if (istDay(new Date(capture.captured_at)) !== istDay(use.now)) {
        return { ok: false, message: "That photo is from an earlier day. A visit is logged on the day it happens: take a new photo." };
    }
    return { ok: true };
}

/**
 * ID 196: may this person log a visit on an existing counter (My Dealers
 * account)? Its owner, or the owner's manager (the owner is one of their
 * direct reports). Nobody else — not even an oversight role: a visit is a
 * record of being there.
 */
export function mayLogAccountVisit(a: {
    userId: string;
    ownerId: string | null | undefined;
    teamIds: readonly string[];
}): boolean {
    if (!a.ownerId) return false;
    return a.ownerId === a.userId || a.teamIds.includes(a.ownerId);
}
