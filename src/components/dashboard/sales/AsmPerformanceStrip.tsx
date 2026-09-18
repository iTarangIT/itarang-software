"use client";

// B7 step 6 — the compact block at the top of the ASM home (/asm): the seven
// KPI cards for the logged-in rep over the default 30-day window, and a link
// to the full My Performance page. No filters, no SPOC picker, no per-SPOC
// table — the ASM endpoint pins the rep to the session.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";

import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import { SalesKpiRow } from "./SalesKpiRow";

const block = "animate-pulse rounded-xl border border-border bg-bg/60 h-20";

export function AsmPerformanceStrip() {
    const query = useQuery<{ success: true; data: SalesDashboard }>({
        queryKey: ["sales-dashboard", "asm", ""],
        queryFn: async () => {
            const res = await fetch("/api/asm/reports/sales-dashboard", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load your numbers");
            }
            return json;
        },
        staleTime: 60 * 1000,
    });
    const d = query.data?.data;

    return (
        <section aria-label="My performance" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-900">My performance</h2>
                <Link
                    href="/asm/performance"
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                >
                    Full view
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
            </div>
            {d ? (
                <SalesKpiRow d={d} compact />
            ) : query.error ? (
                <p className="text-xs text-rose-700">{(query.error as Error).message}</p>
            ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" aria-busy="true">
                    {Array.from({ length: 7 }, (_, i) => (
                        <div key={i} className={block} />
                    ))}
                </div>
            )}
        </section>
    );
}
