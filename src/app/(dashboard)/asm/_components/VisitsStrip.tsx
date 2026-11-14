"use client";

// ID 244 — the one-line numbers strip at the top of My visits. Every number is for whoever
// "Showing" points at, and they add up: hot + warm + cold + not rated = Open leads, and
// Visits today = the Today's visits tab. Read with the tab counts (one request), so the strip
// and the tabs below it can never disagree.

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { VisitsStripNumbers } from "@/lib/asm/types";

const CELLS: Array<{ key: keyof VisitsStripNumbers; label: string; dot: string }> = [
    { key: "open_leads", label: "Open leads", dot: "bg-gray-700" },
    { key: "hot", label: "Hot", dot: "bg-rose-500" },
    { key: "warm", label: "Warm", dot: "bg-amber-500" },
    { key: "cold", label: "Cold", dot: "bg-sky-500" },
    { key: "not_rated", label: "Not rated", dot: "bg-gray-300" },
    { key: "visits_today", label: "Visits today", dot: "bg-blue-600" },
    { key: "next_7_days", label: "Next 7 days", dot: "bg-gray-400" },
    { key: "visits_yesterday", label: "Visits yesterday", dot: "bg-emerald-500" },
    { key: "calls_yesterday", label: "Calls yesterday", dot: "bg-emerald-500" },
];

export function VisitsStrip({ strip, who, loading }: { strip: VisitsStripNumbers | null | undefined; who: string; loading: boolean }) {
    return (
        <section aria-label="Numbers" className="rounded-xl border border-gray-100 bg-white px-4 py-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-gray-600">
                    Every number on this page is for <span className="font-semibold text-gray-900">{who}</span>
                </p>
                <Link href="/asm/performance" className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
                    Full view
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5 xl:grid-cols-9">
                {CELLS.map((c) => (
                    <div key={c.key}>
                        <dt className="flex items-center gap-1.5 text-xs text-gray-500">
                            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                            {c.label}
                        </dt>
                        <dd className="text-xl font-semibold tabular-nums text-gray-900">{strip ? strip[c.key] : loading ? "…" : "—"}</dd>
                    </div>
                ))}
            </dl>
            {strip ? (
                <p className="mt-2 text-xs text-gray-500">
                    {strip.hot} hot + {strip.warm} warm + {strip.cold} cold + {strip.not_rated} not rated = {strip.open_leads} open leads.
                    Visits today = the Today&apos;s visits tab.
                </p>
            ) : null}
        </section>
    );
}
