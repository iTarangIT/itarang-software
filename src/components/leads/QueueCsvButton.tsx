"use client";

/**
 * "Download CSV" for a queue whose rows live on the server.
 *
 * FETCH-THEN-BLOB rather than a plain <a href> download, for three reasons that
 * only show up when something goes wrong:
 *
 *  - A failed export behind a plain link navigates the tab to a JSON error page
 *    and the user loses the filters they had set. Here it stays put and says so.
 *  - The route caps what it returns and reports the cap in `X-Export-Truncated`.
 *    A sheet that is quietly page-one-of-forty is worse than no sheet, so the
 *    cap is surfaced the moment it bites.
 *  - The button can show that it is working. These exports run over thousands of
 *    rows, and a link that appears to do nothing for four seconds gets clicked
 *    four more times.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

type Props = {
    /** The export route WITH the current tab, search and filters already on it. */
    href: string;
    /** Base name; the route appends its own timestamp. */
    filename: string;
    disabled?: boolean;
};

export function QueueCsvButton({ href, filename, disabled }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    async function download() {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const res = await fetch(href, { cache: "no-store" });
            if (!res.ok) throw new Error(`Export failed (${res.status})`);

            const rows = Number(res.headers.get("X-Export-Rows") ?? "0");
            const total = Number(res.headers.get("X-Export-Total") ?? "0");
            const truncated = res.headers.get("X-Export-Truncated") === "1";

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            try {
                const a = document.createElement("a");
                a.href = url;
                // The server also sets a filename in Content-Disposition; this is
                // what a browser that ignores it falls back to.
                a.download = `${filename}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            } finally {
                URL.revokeObjectURL(url);
            }

            if (truncated) {
                setNote(`Exported the first ${rows} of ${total} matching leads.`);
            } else if (rows === 0) {
                // Not an error — the filters simply matched nothing. Said out
                // loud because a downloaded file with one header row and no data
                // otherwise reads as a broken export.
                setNote("No leads matched — the file has headers only.");
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Export failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="relative">
            <button
                type="button"
                onClick={download}
                disabled={disabled || busy}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                title="Download every lead matching the current tab, search and filters"
            >
                {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <Download className="h-4 w-4" />
                )}
                Download CSV
            </button>
            {(error || note) && (
                <p
                    className={`absolute right-0 top-full z-10 mt-1 w-64 rounded-md border px-2 py-1 text-[11px] shadow-sm ${
                        error
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : "border-gray-200 bg-white text-gray-600"
                    }`}
                >
                    {error ?? note}
                </p>
            )}
        </div>
    );
}
