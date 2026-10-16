"use client";

// ID 71 — Finance marks which Google Drive folders hold credit notes. The full
// folder screen (add, remove, filters, scan) stays on Admin › Expense tracker
// for Admin and Sales Head; here anyone with the Invoice Ledger can switch
// what a folder holds. Switching to Credit notes also switches the folder's
// name filter from "sale" to "credit" (the API does it), so its credit notes
// are read on the next scan.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type Folder = {
    id: string;
    label: string | null;
    drive_folder_id: string;
    include_names: string | null;
    doc_kind: "sale" | "credit_note" | null;
    is_active: boolean;
    last_scanned_at?: string | null;
};

const KEY = ["sales-folders"];

export function FolderKindsTab() {
    const qc = useQueryClient();
    const q = useQuery({
        queryKey: KEY,
        queryFn: async () => {
            const r = await fetch("/api/admin/sales-invoices/drive/folders", { cache: "no-store" });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load the folders");
            return (j.data.folders ?? []) as Folder[];
        },
    });

    async function setKind(f: Folder, doc_kind: "sale" | "credit_note") {
        const r = await fetch("/api/admin/sales-invoices/drive/folders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: f.id, doc_kind }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.success) {
            toast.error(j?.error?.message ?? "Could not change the folder");
            return;
        }
        toast.success(
            doc_kind === "credit_note"
                ? "Marked as credit notes — read on the next scan, subtracted from revenue."
                : "Marked as sales invoices.",
        );
        qc.invalidateQueries({ queryKey: KEY });
    }

    if (q.isLoading) return <p className="text-sm text-ink-muted">Loading…</p>;
    if (q.error) return <p className="text-sm text-red-600">{(q.error as Error).message}</p>;
    const folders = q.data ?? [];

    return (
        <div className="space-y-3">
            <p className="text-xs text-ink-muted">
                What each Google Drive folder holds. A credit-note folder is read on the next scan: each note takes its
                amount off revenue and what the dealer owes, and its items off batteries sold, By SKU and gross margin.
                Folders are added and scanned on Admin › Expense tracker.
            </p>
            {folders.length === 0 ? (
                <p className="text-sm text-ink-muted">No sales folders yet.</p>
            ) : (
                <table className="w-full text-xs">
                    <thead className="text-left text-ink-muted">
                        <tr>
                            <th className="py-1.5">Folder</th>
                            <th className="py-1.5">Reads folders named</th>
                            <th className="py-1.5">It holds</th>
                        </tr>
                    </thead>
                    <tbody>
                        {folders.map((f) => (
                            <tr key={f.id} className={`border-t border-border ${f.is_active ? "" : "opacity-60"}`}>
                                <td className="py-1.5">
                                    {f.label ?? f.drive_folder_id}
                                    {!f.is_active && <span className="ml-1 text-ink-muted">(paused)</span>}
                                </td>
                                <td className="py-1.5 text-ink-muted">{f.include_names || "everything"}</td>
                                <td className="py-1.5">
                                    <select
                                        aria-label={`What ${f.label ?? "this folder"} holds`}
                                        value={f.doc_kind ?? "sale"}
                                        onChange={(e) => setKind(f, e.target.value as "sale" | "credit_note")}
                                        className="rounded-md border border-border px-2 py-1"
                                    >
                                        <option value="sale">Sales invoices</option>
                                        <option value="credit_note">Credit notes — subtracted from revenue</option>
                                    </select>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
