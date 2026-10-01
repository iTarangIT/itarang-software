"use client";

// Sales Head view of ASM claims made outside the ASM's territory (tracker
// ID 45): allowed, and listed here. Renders nothing when there are none.
// Mounted on the Sales Head dashboard and the admin dashboard (its API is
// manager-only — it used to sit in the ASM queue, where it always 403'd).

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

type Row = {
    lead_id: string;
    dealer_name: string | null;
    city: string | null;
    state: string | null;
    claimed_by: string | null;
    claimed_at: string;
};

export function OutsideTerritoryClaims() {
    const q = useQuery<{ rows: Row[] }>({
        queryKey: ["outside-territory-claims"],
        queryFn: async () => {
            const res = await fetch("/api/admin/claims/outside-territory", { cache: "no-store" });
            if (!res.ok) return { rows: [] };
            return (await res.json()).data;
        },
    });
    const rows = q.data?.rows ?? [];
    if (rows.length === 0) return null;

    return (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
            <p className="text-xs font-semibold text-amber-800">
                Claimed outside territory — last 30 days ({rows.length})
            </p>
            <ul className="mt-1.5 space-y-1">
                {rows.slice(0, 10).map((r) => (
                    <li key={`${r.lead_id}-${r.claimed_at}`} className="text-xs text-amber-900">
                        <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} className="font-medium underline">
                            {r.dealer_name ?? r.lead_id}
                        </Link>{" "}
                        · {[r.city, r.state].filter(Boolean).join(", ") || "no location"} · by {r.claimed_by ?? "—"} ·{" "}
                        {new Date(r.claimed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                    </li>
                ))}
            </ul>
        </div>
    );
}
