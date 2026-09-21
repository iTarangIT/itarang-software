"use client";

// Review R-24 — the CEO dashboard's data-health row. Until these are near 0 %,
// every other number on the page carries a known under-count; showing them is
// what makes the rest of the screen believable.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import type { DataHealthCheck } from "@/lib/dashboard/dataHealth";

function tone(pct: number | null): string {
    if (pct == null) return "text-gray-400";
    if (pct === 0) return "text-emerald-700";
    if (pct < 10) return "text-amber-700";
    return "text-rose-700";
}

export function DataHealthPanel() {
    const { data, isLoading } = useQuery<{ checks: DataHealthCheck[] }>({
        queryKey: ["ceo-data-health"],
        queryFn: async () => {
            const res = await fetch("/api/dashboard/ceo/data-health", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load data health");
            return json.data;
        },
        staleTime: 5 * 60 * 1000,
    });

    return (
        <div data-testid="ceo-data-health" className="p-5 rounded-2xl bg-white border border-gray-100 shadow-sm">
            <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-brand-600" />
                <div>
                    <h3 className="text-sm font-semibold text-gray-900">Data health</h3>
                    <p className="text-xs text-gray-500">
                        How much of the numbers above is incomplete. Each should be 0 % — until it is,
                        the related figures are under-counted.
                    </p>
                </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(isLoading ? [] : (data?.checks ?? [])).map((c) => (
                    <div key={c.key} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                        <p className="text-[11px] font-medium text-gray-600">{c.label}</p>
                        <p className={`mt-1 text-xl font-bold tabular-nums ${tone(c.pct)}`}>
                            {c.pct == null ? "—" : `${c.pct}%`}
                        </p>
                        <p className="text-[11px] text-gray-500 tabular-nums">
                            {c.bad == null ? "could not be checked" : `${c.bad.toLocaleString("en-IN")} of ${(c.total ?? 0).toLocaleString("en-IN")}`}
                            {" · "}
                            <Link href={c.fix_href} className="font-semibold text-brand-700 hover:underline">
                                {c.fix_label}
                            </Link>
                        </p>
                    </div>
                ))}
                {isLoading && <p className="text-xs text-gray-400">Checking…</p>}
            </div>
        </div>
    );
}
