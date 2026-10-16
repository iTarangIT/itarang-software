/**
 * A39 — "log every download with the user's name". Many export routes log
 * their download themselves (logDataDownload, with the dataset name, filters
 * and row count); the rest returned a file and logged nothing. withErrorHandler
 * (src/lib/api-utils.ts) now runs every route inside this context and, when
 * the response is a file (Content-Disposition: attachment) that the route did
 * not log, records it — who, which address, which query string.
 *
 * Dependency-free on purpose: api-utils imports it, and api-utils is imported
 * by nearly every route.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const downloadLogStore = new AsyncLocalStorage<{ logged: boolean }>();

/** Called by logDataDownload: this request's download is already in the log. */
export function markDownloadLogged(): void {
    const s = downloadLogStore.getStore();
    if (s) s.logged = true;
}

/** Is this response a file the browser saves? */
export function isAttachmentResponse(res: unknown): res is Response {
    if (!(res instanceof Response) || !res.ok) return false;
    return /attachment/i.test(res.headers.get("content-disposition") ?? "");
}

/** The file name from Content-Disposition, if any. */
export function attachmentName(res: Response): string | null {
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return m ? decodeURIComponent(m[1]) : null;
}
