"use client";

// Review R-21 — "what changed on these leads last week": download every event
// (status, owner, interest, calls, visits, quotes, escalations) filtered by the
// date it HAPPENED, for the ticked leads or for all of them.

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import { toast } from "sonner";

function isoDaysAgo(n: number): string {
    const d = new Date(Date.now() + 330 * 60_000 - n * 86_400_000);
    return d.toISOString().slice(0, 10);
}

export function EventLogExportButton({ selectedIds }: { selectedIds: string[] }) {
    const [open, setOpen] = useState(false);
    const [from, setFrom] = useState(() => isoDaysAgo(6));
    const [to, setTo] = useState(() => isoDaysAgo(0));
    const [busy, setBusy] = useState(false);

    const download = async () => {
        setBusy(true);
        try {
            const qs = new URLSearchParams({ from, to });
            if (selectedIds.length) qs.set("lead_ids", selectedIds.join(","));
            const res = await fetch(`/api/admin/exports/lead-events.xlsx?${qs.toString()}`);
            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.error?.message ?? "Export failed");
            }
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement("a");
            a.href = url;
            a.download = `lead-events-${from}-to-${to}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
            setOpen(false);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                title="Download every change on these leads, filtered by the date it happened"
                className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm"
            >
                <History className="w-4 h-4" />
                Event log
            </button>
            {open && (
                <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
                    <p className="text-xs text-gray-600">
                        Events that happened between these dates on{" "}
                        <b>{selectedIds.length ? `${selectedIds.length} selected lead(s)` : "all leads"}</b>.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <label className="text-[11px] text-gray-500">
                            From
                            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-sm" />
                        </label>
                        <label className="text-[11px] text-gray-500">
                            To
                            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-sm" />
                        </label>
                    </div>
                    <button
                        type="button"
                        disabled={busy || !from || !to || from > to}
                        onClick={download}
                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Download
                    </button>
                </div>
            )}
        </div>
    );
}
