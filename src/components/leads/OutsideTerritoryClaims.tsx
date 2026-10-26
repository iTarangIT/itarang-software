"use client";

// Sales Head view of ASM claims made outside the ASM's territory (tracker
// ID 45): allowed, and listed here. Renders nothing when there are none.
// Mounted on the Sales Head dashboard and the admin dashboard, each with its
// own filters (period, state, city, person; team on Sales). Its API is
// manager-only — it used to sit in the ASM queue, where it always 403'd.
// HANDOVER-A6 (23 Oct): "See all" opens every listed claim with a CSV, and the
// card says it checks against today's territories (the lead's "Claimed
// [outside territory]" note is fixed at claim time).
//
// Claims are re-read against today's territories and split by why: outside
// the territory (the list), no location on the lead, or no territory set up
// for the ASM — the last two are data / setup gaps, shown apart so they do not
// read as stray claims.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import type { OutsideClaimRow, OutsideClaimsResponse } from "@/app/api/admin/claims/outside-territory/route";
import { SalesDrillModal, type SalesDrillTarget } from "@/components/dashboard/sales/SalesDrillModal";
import type { DrillRow } from "@/lib/dashboard/salesDrill";

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

const CLAIM_DETAIL: Record<OutsideClaimRow["status"], string> = {
    outside: "Outside the ASM's territory (today's territories)",
    no_location: "No state / city on the lead",
    territory_not_set: "No territory set up for the ASM",
};

/** A claim as a row of the dashboard's click-to-list popup (and its CSV). */
function drillRow(r: OutsideClaimRow): DrillRow {
    return {
        id: r.lead_id,
        href: `/leads/${encodeURIComponent(r.lead_id)}`,
        name: r.dealer_name ?? r.lead_id,
        phone: null,
        city: r.city,
        state: r.state,
        status: null,
        rating: null,
        person_id: r.claimed_by_id,
        person_name: r.claimed_by,
        owner_name: null,
        at: r.claimed_at,
        detail: CLAIM_DETAIL[r.status],
    };
}

function SeeAll({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <li>
            <button type="button" onClick={onClick} className="text-xs font-semibold text-amber-800 underline hover:text-amber-900">
                {label}
            </button>
        </li>
    );
}

export function OutsideTerritoryClaims({ filters = {} }: { filters?: OutsideTerritoryFilters }) {
    const [drill, setDrill] = useState<SalesDrillTarget | null>(null);
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
    const open = (title: string, list: OutsideClaimRow[], count: number, csv: string) =>
        setDrill({ title: `${title} — ${period}`, count, rows: list.map(drillRow), csvName: csv });
    const capped = (shown: number, count: number) => (count > shown ? ` (first ${shown} of ${count})` : "");

    return (
        <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
            <div>
                <p className="text-xs font-semibold text-amber-800">
                    Claimed outside territory — {period} ({d.counts.outside})
                </p>
                <p className="text-[11px] text-amber-700">
                    Checked against today&apos;s territories: a territory set after the claim clears it here, while the lead&apos;s own
                    &ldquo;Claimed [outside territory]&rdquo; note stays as it was at the claim.
                </p>
                {outside.length > 0 ? (
                    <ul className="mt-1.5 space-y-1">
                        {outside.slice(0, SHOWN).map((r) => (
                            <ClaimLine key={`${r.lead_id}-${r.claimed_at}`} r={r} />
                        ))}
                        {d.counts.outside > SHOWN && (
                            <SeeAll
                                label={`See all ${d.counts.outside}${capped(outside.length, d.counts.outside)}`}
                                onClick={() => open("Claimed outside territory", outside, d.counts.outside, "claims-outside-territory")}
                            />
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
                        {d.counts.no_location > 5 && (
                            <SeeAll
                                label={`See all ${d.counts.no_location}${capped(noLocation.length, d.counts.no_location)}`}
                                onClick={() => open("Claims with no location on the lead", noLocation, d.counts.no_location, "claims-no-location")}
                            />
                        )}
                    </ul>
                </div>
            )}

            {d.no_territory.length > 0 && (
                <p className="border-t border-amber-200 pt-2 text-xs text-amber-900">
                    <span className="font-semibold text-amber-800">No territory set up</span> for{" "}
                    {d.no_territory.map((a) => `${a.name ?? "an ASM"} (${a.claims} claim${a.claims === 1 ? "" : "s"})`).join(", ")} — their
                    claims cannot be checked. Set territories in Admin › Settings › Territories.{" "}
                    <button
                        type="button"
                        className="font-semibold text-amber-800 underline hover:text-amber-900"
                        onClick={() => {
                            const list = d.rows.filter((r) => r.status === "territory_not_set");
                            open("Claims by ASMs with no territory", list, d.counts.territory_not_set, "claims-no-territory");
                        }}
                    >
                        See the claims
                    </button>
                </p>
            )}

            {drill && <SalesDrillModal target={drill} onClose={() => setDrill(null)} />}
        </div>
    );
}
