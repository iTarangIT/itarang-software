// Browser half of "fresh link on each click, valid 15 minutes" (tracker ID 166).
//
// A View / Open button calls openFreshFile(url) (or uses it as an <a> onClick).
// For a stored file (/api/files/...) it asks GET /api/files/link for a link
// signed for this user that expires in 15 minutes, and opens THAT, so the
// address a person copies out of the new tab and pastes into WhatsApp stops
// working after 15 minutes. Anything else opens as before.
//
// No server imports: safe in client components.

/**
 * Is this a stored file (relative or absolute): a files-proxy path, or (16
 * Oct) an NBFC store path, /nbfc-uploads/… or /api/nbfc-uploads/…?
 */
export function isStoredFileUrl(url: string | null | undefined): url is string {
    if (typeof url !== "string") return false;
    if (url.includes("/api/files/")) return !url.includes("/api/files/link") && !url.includes("/api/files/open");
    return url.includes("/nbfc-uploads/");
}

/**
 * A fresh 15-minute link for a stored file, or the URL unchanged when it is
 * not one. Throws with a readable message when the user may not open it.
 * If the link service cannot be reached the stored path is returned: it still
 * opens with the session for a user who may see it.
 */
export async function freshFileUrl(url: string): Promise<string> {
    if (!isStoredFileUrl(url)) return url;
    let res: Response;
    try {
        res = await fetch(`/api/files/link?u=${encodeURIComponent(url)}`, {
            cache: "no-store",
            credentials: "same-origin",
        });
    } catch {
        return url;
    }
    const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    if (res.status === 401 || res.status === 403) {
        throw new Error(body?.error || "You can't open this file.");
    }
    return res.ok && body?.url ? body.url : url;
}

/**
 * Open a stored file in a new tab through a fresh link. The tab is opened
 * synchronously (inside the click) so pop-up blockers allow it, then pointed
 * at the signed link once it arrives.
 */
export async function openFreshFile(url: string | null | undefined): Promise<void> {
    if (!url) return;
    if (!isStoredFileUrl(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
    }
    const tab = window.open("about:blank", "_blank");
    try {
        const fresh = await freshFileUrl(url);
        if (tab) {
            tab.opener = null;
            tab.location.href = fresh;
        } else {
            window.open(fresh, "_blank", "noopener,noreferrer");
        }
    } catch (err) {
        tab?.close();
        window.alert(err instanceof Error ? err.message : "You can't open this file.");
    }
}

/**
 * onClick for an existing `<a href={storedUrl} target="_blank">`: a stored
 * file opens through a fresh link; any other link (and a modified click, such
 * as Ctrl+click) behaves as a normal link.
 */
export function onFreshFileClick(
    e: { preventDefault(): void; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; button?: number },
    url: string | null | undefined,
): void {
    if (!isStoredFileUrl(url)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || (e.button ?? 0) !== 0) return;
    e.preventDefault();
    void openFreshFile(url);
}
