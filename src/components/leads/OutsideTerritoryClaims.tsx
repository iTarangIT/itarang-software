"use client";

// Sales Head view of ASM claims made outside the ASM's territory (tracker
// ID 45): allowed, and listed here. Renders nothing when there are none.
// Mounted on the Sales Head dashboard (with its filters: period, state, city,
// person, team) and the admin dashboard (no filters: the last 30 days). Its API
// is manager-only — it used to sit in the ASM queue, where it always 403'd.
//
// Claims are re-read against today's territories and split by why: outside
// the territory (the list), no location on the lead, or no territory set up
// for the ASM — the last two are data / setup gaps, shown apart so they do not
// read as stray claims.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import type { OutsideClaimRow, OutsideClaimsResponse } from "@/app/api/admin/claims/outside-territory/route";

export type OutsideTerritoryFilters = {
    from?: string;
    to?: string;
    state?: string;
    city?: string;
    spoc_id?: string;
    team?: string;
};

const SHOWN = 10;

const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function ClaimLine({ r }: { r: OutsideClaimRow }) {
    return (
        <li className="text-xs text-amber-900">
            <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} className="font-medium underline">
                {r.dealer_name ?? r.lead_id}
            </Link>{" "}
            · {[r.city, r.state].filter(Boolean).join(", ") || "no location"} · by {r.claimed_by ?? "—"} ·{" "}
            {new Date(r.claimed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
        </li>
    );
}

export function OutsideTerritoryClaims({ filters = {} }: { filters?: OutsideTerritoryFilters }) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && !(k === "team" && v === "all")) qs.set(k, v);
    const q = useQuery<OutsideClaimsResponse | null>({
        queryKey: ["outside-territory-claims", qs.toString()],
        queryFn: async () => {
            const res = await fetch(`/api/admin/claims/outside-territory${qs.toString() ? `?${qs}` : ""}`, { cache: "no-store" });
            if (!res.ok) return null;
            return (await res.json()).data;
        },
        placeholderData: (prev) => prev,
    });
    const d = q.data;
    if (!d || d.counts.outside + d.counts.no_location + d.counts.territory_not_set === 0) return null;

    const outside = d.rows.filter((r) => r.status === "outside");
    const noLocation = d.rows.filter((r) => r.status === "no_location");
    const period = d.from && d.to ? (d.from === d.to ? fmtDay(d.from) : `${fmtDay(d.from)} – ${fmtDay(d.to)}`) : "last 30 days";

    return (
        <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
            <div>
                <p className="text-xs font-semibold text-amber-800">
                    Claimed outside territory — {period} ({d.counts.outside})
                </p>
                {outside.length > 0 ? (
                    <ul className="mt-1.5 space-y-1">
                        {outside.slice(0, SHOWN).map((r) => (
                            <ClaimLine key={`${r.lead_id}-${r.claimed_at}`} r={r} />
                        ))}
                        {d.counts.outside > SHOWN && (
                            <li className="text-xs text-amber-800">+ {d.counts.outside - SHOWN} more</li>
                        )}
                    </ul>
                ) : (
                    <p className="mt-1 text-xs text-amber-900">None.</p>
                )}
            </div>

            {d.counts.no_location > 0 && (
                <div className="border-t border-amber-200 pt-2">
                    <p className="text-xs font-semibold text-amber-800">
                        No location on the lead ({d.counts.no_location}) — cannot be checked; add the lead&apos;s state and city
                    </p>
                    <ul className="mt-1 space-y-1">
                        {noLocation.slice(0, 5).map((r) => (
                            <ClaimLine key={`${r.lead_id}-${r.claimed_at}`} r={r} />
                        ))}
                        {d.counts.no_location > 5 && <li className="text-xs text-amber-800">+ {d.counts.no_location - 5} more</li>}
                    </ul>
                </div>
            )}

            {d.no_territory.length > 0 && (
                <p className="border-t border-amber-200 pt-2 text-xs text-amber-900">
                    <span className="font-semibold text-amber-800">No territory set up</span> for{" "}
                    {d.no_territory.map((a) => `${a.name ?? "an ASM"} (${a.claims} claim${a.claims === 1 ? "" : "s"})`).join(", ")} — their
                    claims cannot be checked. Set territories in Admin › Settings › Territories.
                </p>
            )}
        </div>
    );
}
