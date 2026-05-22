"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, CalendarDays, Sparkles, Target } from "lucide-react";
import type { Kpis } from "@/lib/sales-insight/types";

type Props = {
    kpis: Kpis | undefined;
    loading: boolean;
};

function formatNumber(n: number | null | undefined) {
    if (n === null || n === undefined) return "—";
    return n.toLocaleString("en-IN");
}

export function KpiCards({ kpis, loading }: Props) {
    const total = kpis?.total_converted ?? null;
    const mtd = kpis?.this_month_converted ?? null;
    const avgIntent = kpis?.avg_intent_score_ai ?? null;
    const rate = kpis?.conversion_rate_pct ?? null;

    return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card className="bg-blue-50/50 border-blue-100">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-blue-900">Total Converted</CardTitle>
                    <TrendingUp className="h-4 w-4 text-blue-600" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-blue-900">
                        {loading ? "…" : formatNumber(total)}
                    </div>
                    <p className="text-xs text-blue-600">Across both pipelines</p>
                </CardContent>
            </Card>

            <Card className="bg-emerald-50/50 border-emerald-100">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-emerald-900">This Month</CardTitle>
                    <CalendarDays className="h-4 w-4 text-emerald-600" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-emerald-900">
                        {loading ? "…" : formatNumber(mtd)}
                    </div>
                    <p className="text-xs text-emerald-600">Converted MTD</p>
                </CardContent>
            </Card>

            <Card className="bg-amber-50/50 border-amber-100">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-amber-900">Avg Intent (AI)</CardTitle>
                    <Sparkles className="h-4 w-4 text-amber-600" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-amber-900">
                        {loading ? "…" : avgIntent === null ? "—" : avgIntent}
                    </div>
                    <p className="text-xs text-amber-600">AI-dialer-sourced leads only</p>
                </CardContent>
            </Card>

            <Card className="bg-rose-50/50 border-rose-100">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-rose-900">Conversion Rate</CardTitle>
                    <Target className="h-4 w-4 text-rose-600" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold text-rose-900">
                        {loading ? "…" : rate === null ? "—" : `${rate}%`}
                    </div>
                    <p className="text-xs text-rose-600">Converted ÷ all leads</p>
                </CardContent>
            </Card>
        </div>
    );
}
