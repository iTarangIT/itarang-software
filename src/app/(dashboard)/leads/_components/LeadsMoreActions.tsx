"use client";

// C37 (wording audit, 2 Nov): the Leads header keeps three buttons in view
// (Import, Download, New lead). The less-used actions sit in this "More" menu.
// The menu stays open while you work inside it (the Activity log date picker
// opens in place) and closes on a click outside or Escape.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileSpreadsheet, Loader2 } from "lucide-react";
import { EventLogExportButton } from "@/components/leads/EventLogExportButton";

export function LeadsMoreActions({
    onDownloadAll,
    downloadingAll,
    selectedIds,
}: {
    onDownloadAll: () => void;
    downloadingAll: boolean;
    selectedIds: string[];
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm"
            >
                More
                <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl"
                >
                    {/* B11 — the full download (visits, calls, remarks, billing). */}
                    <button
                        type="button"
                        role="menuitem"
                        onClick={onDownloadAll}
                        disabled={downloadingAll}
                        title="Every lead that matches your filters, with visit, call, remarks and billing columns."
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                        {downloadingAll ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <FileSpreadsheet className="w-4 h-4" />
                        )}
                        Download full sheet
                    </button>
                    {/* R-21 — every event on these leads, by the date it happened. */}
                    <EventLogExportButton selectedIds={selectedIds} variant="menu" />
                </div>
            )}
        </div>
    );
}
