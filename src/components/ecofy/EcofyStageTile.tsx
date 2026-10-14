"use client";

// Tracker ID 51 #2 — a small, separate Ecofy block for the Sales Head and CEO
// dashboards: Ecofy (solar) leads by current Ecofy stage. Deliberately its own
// card with its own data (GET /api/ecofy/stage-summary) — never merged into the
// dealer funnel numbers next to it. Renders nothing when the database has no
// Ecofy leads table, no Ecofy leads at all, or the viewer is not a Sales Head
// / CEO (SalesHeadOpsView is also mounted on admin pages).

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { SalesDrillModal, type SalesDrillTarget } from "@/components/dashboard/sales/SalesDrillModal";
import type { EcofyStageSummary } from "@/lib/ecofy/stageSummary";
import { ecofyGet } from "./client";

export function EcofyStageTile({ href = "/sales-head/ecofy" }: { href?: string }) {
    const q = useQuery<EcofyStageSummary>({
        queryKey: ["ecofy-stage-summary"],
        queryFn: () => ecofyGet<EcofyStageSummary>("/api/ecofy/stage-summary"),
        staleTime: 60_000,
        // The view is shared with admin screens; a role outside the Ecofy
        // workspace gets 403 and the tile simply stays hidden.
        retry: false,
    });
    // A clicked number: the Ecofy leads behind it, with Download CSV.
    const [drill, setDrill] = useState<SalesDrillTarget | null>(null);
    const s = q.data;
    if (!s || !s.available || s.total === 0) return null;
    const open = (title: string, count: number, kind: string, key?: string) =>
        count > 0 && setDrill({ title, count, query: new URLSearchParams({ kind, ...(key ? { key } : {}) }).toString() });
    const numBtn = "font-bold text-gray-900 underline-offset-2 hover:text-blue-700 hover:underline";

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-4" aria-label="Ecofy leads by stage">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-gray-900">Ecofy leads (separate pipeline)</h3>
                    <p className="text-xs text-gray-500">
                        Solar leads synced from Ecofy, by their current Ecofy stage. Not included in the dealer funnel.
                    </p>
                </div>
                <Link href={href} className="text-xs font-medium text-blue-700 hover:underline">
                    Open Ecofy →
                </Link>
            </div>
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
                <span>
                    <button type="button" className={numBtn} onClick={() => open("Ecofy leads — all", s.total, "ecofy_all")}>
                        {s.total}
                    </button>{" "}
                    <span className="text-gray-500">all</span>
                </span>
                <span>
                    <button type="button" className={numBtn} onClick={() => open("Ecofy leads — open", s.open, "ecofy_open")}>
                        {s.open}
                    </button>{" "}
                    <span className="text-gray-500">open</span>
                </span>
                <span>
                    <button type="button" className={numBtn} onClick={() => open("Ecofy leads — pickup queue", s.queue, "ecofy_queue")}>
                        {s.queue}
                    </button>{" "}
                    <span className="text-gray-500">in pickup queue (unassigned)</span>
                </span>
            </div>
            <ul className="flex flex-wrap gap-2">
                {s.byStage.map((r) => (
                    <li key={r.stage}>
                        <button
                            type="button"
                            onClick={() => open(`Ecofy leads — ${r.stage === "UNKNOWN" ? "" : `${r.stage} `}${r.label}`, r.count, "ecofy_stage", r.stage)}
                            className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                            title="See these leads"
                        >
                            <span className="font-mono text-gray-500">{r.stage === "UNKNOWN" ? "—" : r.stage}</span> {r.label}{" "}
                            <b className="text-gray-900">{r.count}</b>
                        </button>
                    </li>
                ))}
            </ul>
            {drill && <SalesDrillModal target={drill} onClose={() => setDrill(null)} />}
        </section>
    );
}
