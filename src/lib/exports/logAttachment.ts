/**
 * A39 — record a file download the route itself did not log (see
 * downloadContext.ts). Resolves the signed-in user, then writes one
 * data_download_log row: dataset "file:<path>", the query string as filters,
 * the file name. Never throws; a download is never blocked by its log.
 */
import { attachmentName } from "@/lib/exports/downloadContext";
import { logDataDownload } from "@/lib/exports/downloadLog";

export async function logAttachmentDownload(req: Request, res: Response): Promise<void> {
    try {
        const { requireAuthWithSupabaseUser } = await import("@/lib/auth-utils");
        const { dbUser } = await requireAuthWithSupabaseUser();
        const url = new URL(req.url);
        const filters: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
        const file = attachmentName(res);
        if (file) filters.file = file;
        await logDataDownload({
            userId: dbUser.id,
            role: dbUser.role,
            dataset: `file:${url.pathname}`.slice(0, 80),
            rowCount: 0,
            ownOnly: false,
            filters,
            format: /\.csv$/i.test(file ?? "") ? "csv" : /\.xlsx$/i.test(file ?? "") ? "xlsx" : undefined,
        });
    } catch {
        // Not signed in (a public file link, a cron) or the log table is
        // missing: the download already went out; nothing to record.
    }
}
