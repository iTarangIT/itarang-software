"use client";

// ID 207 — Admin clears a switchboard / dead-number mark so the next AI
// campaign dials the number again (POST /api/admin/leads/[id]/clear-phone-mark).
// The page renders it only for Admin and only when the number is marked.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function ClearPhoneMarkButton({
    leadId,
    mark,
}: {
    leadId: string;
    mark: "switchboard" | "dead_number";
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const label = mark === "switchboard" ? "IVR" : "dead number";

    async function clear() {
        setBusy(true);
        try {
            const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/clear-phone-mark`, {
                method: "POST",
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || json?.success === false) {
                toast.error(json?.error?.message ?? "Could not clear the mark");
                return;
            }
            toast.success(`The ${label} mark is cleared: the next campaign dials this number again`);
            router.refresh();
        } finally {
            setBusy(false);
        }
    }

    return (
        <button
            type="button"
            onClick={clear}
            disabled={busy}
            title={`Clear the ${label} mark on this number so AI campaigns dial it again`}
            className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
            {busy ? "Clearing…" : `Clear ${label} mark`}
        </button>
    );
}
