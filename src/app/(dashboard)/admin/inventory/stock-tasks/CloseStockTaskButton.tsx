"use client";

// ID 174 — close a "Stock to upload" task by hand, with a reason (e.g. the
// invoice was cancelled). Normal tasks close by themselves.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CloseStockTaskButton({ taskId }: { taskId: number }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/inventory/stock-tasks/${taskId}/close`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.success) {
                setError(json?.error?.message || "Could not close the task.");
                return;
            }
            setOpen(false);
            router.refresh();
        } finally {
            setBusy(false);
        }
    };

    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-gray-600 hover:underline">
                Close by hand…
            </button>
        );
    }
    return (
        <div className="flex flex-wrap items-center gap-2">
            <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why (e.g. invoice cancelled)"
                className="min-w-[240px] flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
            <button
                type="button"
                disabled={busy || note.trim().length < 3}
                onClick={submit}
                className="rounded-md bg-gray-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
                Close task
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-600 hover:underline">
                Cancel
            </button>
            {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
    );
}
