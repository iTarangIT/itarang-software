// ID 166 — file links inside a download. A spreadsheet must never carry a
// working file link: it is forwarded, kept and opened months later. Each cell
// instead points at a CRM address that checks whoever clicks it and then
// hands out a fresh 15-minute link:
//   - a file in iTarang storage → /api/files/open?u=… (fileOpenHref);
//   - an AI call recording still on the provider's link → the recording route
//     (/api/ai-dialer/recording/<call id>), which checks the person, copies
//     the recording into iTarang storage and then does the same;
//   - any other outside link (a NeoDove recording not yet copied, a bill on an
//     old store) → no link at all, a note saying where to open it.
// Pure: no db, no env reads except the origin helper.

import { fileOpenHref } from "@/lib/storage/fileAccess";

export const RECORDING_NOT_COPIED =
    "Not yet copied to iTarang storage - play it from the lead's call history in the CRM";
export const BILL_OUTSIDE_STORAGE = "Kept outside iTarang storage - open it from the Expenses screen in the CRM";

/** The CRM's own address, for links written into a file (no trailing slash). */
export function exportOrigin(env: Record<string, string | undefined> = process.env): string {
    return (env.APP_URL || env.NEXT_PUBLIC_APP_URL || "https://crm.itarang.com").replace(/\/+$/, "");
}

/** The Recording cell of the Calls download. */
export function recordingCell(stored: unknown, aiCallId: unknown, origin: string): string | null {
    const url = typeof stored === "string" ? stored.trim() : "";
    if (!url) return null;
    const own = fileOpenHref(url, origin);
    if (own) return own;
    const callId = typeof aiCallId === "string" ? aiCallId.trim() : "";
    if (callId) return `${origin.replace(/\/+$/, "")}/api/ai-dialer/recording/${encodeURIComponent(callId)}`;
    return RECORDING_NOT_COPIED;
}

/** The Bill link cell of the Expenses download. */
export function billCell(stored: unknown, origin: string): string | null {
    const url = typeof stored === "string" ? stored.trim() : "";
    if (!url) return null;
    return fileOpenHref(url, origin) ?? BILL_OUTSIDE_STORAGE;
}
