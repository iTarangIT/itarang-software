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

/**
 * E-396 — WhatsApp visit proof. A WhatsApp location pin has no accuracy and
 * the ASM can move it, so instead of accuracy it must land within this many
 * metres of the shop's known position (the first verified visit there, or a
 * street-level geocode of the address).
 */
export const MAX_SHOP_DISTANCE_M = 100;

/** The camera photo must follow the pin within this window. */
export const WA_PROOF_WINDOW_MS = 20 * 60_000;

/**
 * The pin half of a WhatsApp proof. `meters` null = the shop has no known
 * position yet (this visit becomes it), which is accepted.
 */
export function checkShopDistance(meters: number | null): CaptureCheck {
    if (meters == null) return { ok: true };
    if (!Number.isFinite(meters) || meters > MAX_SHOP_DISTANCE_M) {
        const far = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
        return {
            ok: false,
            message:
                `📍 This location is ${far} from the shop. A visit is saved only within ${MAX_SHOP_DISTANCE_M} m of the shop. ` +
                `Stand at the shop and send your *current* location again (tap 📎 → Location → Send your current location).`,
        };
    }
    return { ok: true };
}

/** Is the photo within the window after the pin? */
export function checkProofWindow(pinAt: Date | string, photoAt: Date): CaptureCheck {
    const gap = photoAt.getTime() - new Date(pinAt).getTime();
    if (!Number.isFinite(gap) || gap < 0 || gap > WA_PROOF_WINDOW_MS) {
        return {
            ok: false,
            message: `The photo came more than ${WA_PROOF_WINDOW_MS / 60_000} minutes after your location. Send your current location again, then take the photo.`,
        };
    }
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
 * 25 Nov item 9: roles that may log a visit on ANY onboarded dealer account —
 * owned by someone else, or by nobody (most accounts carry no owner yet). The
 * ASM is the field role; the visit is still proved by a same-day photo + GPS.
 */
export const ACCOUNT_VISIT_ANY_ROLES = ["asm"] as const;

/**
 * ID 196: may this person log a visit on an existing counter (My Dealers
 * account)? Its owner, or the owner's manager (the owner is one of their
 * direct reports) — and, since 25 Nov (item 9), any ASM. Nobody else — not
 * even an oversight role: a visit is a record of being there.
 */
export function mayLogAccountVisit(a: {
    userId: string;
    ownerId: string | null | undefined;
    teamIds: readonly string[];
    role?: string | null;
}): boolean {
    if (a.role && (ACCOUNT_VISIT_ANY_ROLES as readonly string[]).includes(a.role)) return true;
    if (!a.ownerId) return false;
    return a.ownerId === a.userId || a.teamIds.includes(a.ownerId);
}
