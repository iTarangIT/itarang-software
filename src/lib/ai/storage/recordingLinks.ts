// The recording link a screen may hand to the browser (tracker ID 166, 18 Oct
// item 7).
//
// A call recording is stored either in iTarang storage (the /api/files proxy,
// which applies the file rule on every open) or — for calls made before the
// copy-on-arrival change and for any copy that failed — as the provider's own
// open link (Bolna, NeoDove), which plays for anyone who holds it. Screens must
// never pass the provider link on. They get our link, or a checked CRM play
// route that copies the recording into our storage on first play and then
// redirects to a fresh 15-minute link after the file rule:
//   - an AI call (ai_call_logs.call_id) → /api/ai-dialer/recording/<callId>
//   - a touchpoint (NeoDove / manual call) → /api/lead-touchpoints/<id>/recording
// With neither id there is no safe link, so no link (null).
//
// Pure: no db or env imports, so it unit-tests alone and client code may use it.

const BUCKET = "call-recordings";

/**
 * Is this recording link already in iTarang storage (the /api/files proxy,
 * relative or absolute, or the call-recordings bucket on Supabase)?
 */
export function isOwnRecordingUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return url.includes(`/api/files/${BUCKET}/`) || url.includes(`/storage/v1/object/public/${BUCKET}/`);
}

/** The checked play route for an AI call. */
export function callRecordingPlayPath(callId: string): string {
    return `/api/ai-dialer/recording/${encodeURIComponent(callId)}`;
}

/** The checked play route for a touchpoint's recording. */
export function touchpointRecordingPlayPath(touchpointId: string): string {
    return `/api/lead-touchpoints/${encodeURIComponent(touchpointId)}/recording`;
}

/** Is this one of the checked play routes above (already safe to hand out)? */
export function isCheckedPlayPath(url: string | null | undefined): boolean {
    if (!url) return false;
    return /^\/api\/ai-dialer\/recording\/[^/]+$/.test(url) || /^\/api\/lead-touchpoints\/[^/]+\/recording$/.test(url);
}

/**
 * The link to show for an AI call's recording. Our own copy as stored; a
 * provider link (or no link yet — ElevenLabs and late Bolna recordings) via the
 * checked play route; nothing when there is no call id to route by.
 */
export function callRecordingLink(callId: string | null | undefined, stored: string | null | undefined): string | null {
    const url = (stored ?? "").trim();
    if (url && (isOwnRecordingUrl(url) || isCheckedPlayPath(url))) return url;
    const id = (callId ?? "").trim();
    return id ? callRecordingPlayPath(id) : null;
}

/**
 * The link to show for a touchpoint's recording (NeoDove and other calls kept
 * on lead_touchpoints). Unlike an AI call, a touchpoint with no stored link has
 * no recording at all, so that stays null.
 */
export function touchpointRecordingLink(
    touchpointId: string | null | undefined,
    stored: string | null | undefined,
): string | null {
    const url = (stored ?? "").trim();
    if (!url) return null;
    if (isOwnRecordingUrl(url) || isCheckedPlayPath(url)) return url;
    const id = (touchpointId ?? "").trim();
    return id ? touchpointRecordingPlayPath(id) : null;
}
