// ID 223 — what the download pages say when a download does not come back.
//
// "The download failed." was all the page could say when the answer was not
// the API's own JSON: the live proxy (Cloudflare / nginx) gives up on a slow
// request with an HTML 502 / 504 / 524 page, and an out-of-memory restart cuts
// the connection. Both mean the file took too long to build. Client-safe.

export const TOOK_TOO_LONG = "The file took too long. Use Email me the file or pick fewer dates.";

/** Statuses a proxy or gateway answers with when the app did not answer in time. */
const GATEWAY = new Set([502, 503, 504, 520, 522, 524]);

/**
 * The message for a failed download: the API's own message when it sent one,
 * otherwise "took too long" for a gateway answer or a body that is not the
 * API's JSON, else a plain failure.
 */
export function downloadFailureMessage(status: number, json: unknown): string {
    const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) return message;
    if (GATEWAY.has(status) || json === null) return TOOK_TOO_LONG;
    return "The download failed.";
}
