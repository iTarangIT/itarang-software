"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

// Number Repair actions (tracker ID 36):
//   Repair   a new 10-digit number, or blank to confirm the current one, plus a
//            short note. Confirming does NOT lift a dead-number flag.
//   Lost     "Repair failed → Lost": closes the lead (reason 'other').
export function RepairNumberButton({ leadId }: { leadId: string }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const post = async (body: Record<string, unknown>) => {
        const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/repair-number`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) {
            const dup = json?.error?.duplicate_lead_id as string | undefined;
            throw new Error(
                dup
                    ? `${json?.error?.message ?? "Duplicate number"} Open /leads/${dup} to merge or close one of them.`
                    : json?.error?.message ?? "Could not save",
            );
        }
        return json?.data ?? json;
    };

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
            const data = await post({ action: "repair", new_phone: phone.trim() || null, note: note.trim() });
            if (data?.cleared === false) {
                toast.info("Note saved. A dead number stays flagged until it is fixed or the lead is closed.");
            } else {
                toast.success("Number repaired — the lead is back in the working queues.");
            }
            router.refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const markLost = async () => {
        if (!window.confirm("Close this lead as Lost (Number repair failed)?")) return;
        const note = window.prompt("Anything to add? (optional)", "");
        if (note === null) return;
        setBusy(true);
        try {
            await post({ action: "mark_lost", note: note.trim() || null });
            toast.success("Lead closed as Lost — number repair failed.");
            router.refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={repair}
                disabled={busy}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
                {busy ? "Saving…" : "Repair"}
            </button>
            <button
                type="button"
                onClick={markLost}
                disabled={busy}
                title="Repair failed → close the lead as Lost"
                className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
                Repair failed → Lost
            </button>
        </div>
    );
}
