"use client";

// Delete a NeoDove campaign for good (26 Oct, Admin / Sales Head). Hard delete:
// see DELETE /api/neodove/campaigns/[id] for exactly what goes and what stays.
// The name must be typed to confirm, because there is no undo.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2, X } from "lucide-react";
import { useNeodoveSetup } from "./neodove-setup";

export function NeodoveDeleteCampaignButton({
    campaignId,
    campaignName,
    pushedLeads,
    compact = false,
    onDeleted,
}: {
    campaignId: string;
    campaignName: string;
    /** Leads whose push history goes with the campaign. Unknown on the list page. */
    pushedLeads?: number;
    compact?: boolean;
    onDeleted: () => void;
}) {
    const setup = useNeodoveSetup();
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);

    if (!setup.data?.canManage) return null;

    async function remove() {
        setBusy(true);
        try {
            const r = await fetch(`/api/neodove/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j?.success) throw new Error(j?.error?.message ?? "Could not delete the campaign");
            toast.success(`"${campaignName}" deleted.`);
            setOpen(false);
            onDeleted();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <button
                type="button"
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setTyped("");
                    setOpen(true);
                }}
                title="Delete campaign"
                className={
                    compact
                        ? "rounded-md p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                        : "inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
                }
            >
                <Trash2 className="w-4 h-4" />
                {!compact && "Delete"}
            </button>

            {open && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
                        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
                            <h2 className="text-base font-semibold text-gray-900">Delete campaign</h2>
                            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="space-y-3 px-6 py-5 text-sm text-gray-700">
                            <p>
                                This removes <strong>{campaignName}</strong> and its stored NeoDove URL from the CRM. It
                                cannot be undone.
                            </p>
                            <ul className="list-disc space-y-1 pl-5 text-xs text-gray-600">
                                <li>
                                    The push history of {pushedLeads != null ? <strong>{pushedLeads} lead(s)</strong> : "its leads"} into this
                                    campaign is removed.
                                </li>
                                <li>The leads themselves, their owners and their NeoDove call records stay.</li>
                                <li>The campaign inside NeoDove is not touched — delete it there too if it is finished.</li>
                            </ul>
                            <label className="block text-xs font-medium text-gray-700">
                                Type the campaign name to confirm
                                <input
                                    value={typed}
                                    onChange={(e) => setTyped(e.target.value)}
                                    placeholder={campaignName}
                                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                                />
                            </label>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
                            <button
                                onClick={() => setOpen(false)}
                                className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={remove}
                                disabled={busy || typed.trim() !== campaignName.trim()}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                            >
                                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Delete for good
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
