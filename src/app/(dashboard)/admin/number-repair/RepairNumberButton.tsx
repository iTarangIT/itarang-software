"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

// Number Repair action (tracker ID 36): a new 10-digit number, or blank to
// confirm the current one, plus a short note.
export function RepairNumberButton({ leadId }: { leadId: string }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const repair = async () => {
        const phone = window.prompt("New 10-digit number (leave blank to keep the current one):", "");
        if (phone === null) return;
        const note = window.prompt("What was done? (e.g. got the right number from the dealer's shop)", "");
        if (!note || note.trim().length < 3) {
            toast.error("Add a short note.");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/repair-number`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ new_phone: phone.trim() || null, note: note.trim() }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not repair the number");
            toast.success("Number repaired — the lead is back in the working queues.");
            router.refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={repair}
            disabled={busy}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
            {busy ? "Saving…" : "Repair"}
        </button>
    );
}
