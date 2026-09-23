"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, LogOut, RefreshCw } from "lucide-react";

import { AttentionTable } from "@/components/monitor/AttentionTable";
import { DistanceTrend } from "@/components/monitor/DistanceTrend";
import { KpiTile, type Tone } from "@/components/monitor/KpiTile";
import { NotMeasurableStrip } from "@/components/monitor/NotMeasurableStrip";
import { SilenceBands } from "@/components/monitor/SilenceBands";
import { SocDistribution } from "@/components/monitor/SocDistribution";
import { freshnessPill, relativeAge } from "@/lib/telemetry/monitor-math";
import type { MonitorOverview } from "@/lib/telemetry/monitor-queries";

const POLL_MS = 60_000;

type Envelope = {
    success: boolean;
    degraded?: boolean;
    reason?: string;
    data: MonitorOverview;
    error?: { message?: string };
};

async function fetchOverview(): Promise<Envelope> {
    const res = await fetch("/api/monitor/overview", { cache: "no-store" });
    const body = (await res.json()) as Envelope;
    if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || `Request failed (${res.status})`);
    }
    return body;
}

const PILL: Record<string, string> = {
    live: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    stale: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    frozen: "bg-red-500/15 text-red-300 ring-red-400/30",
    never: "bg-slate-500/15 text-slate-300 ring-slate-400/30",
};

export function MonitorDashboard() {
    const { data, error, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery({
        queryKey: ["monitor-overview"],
        queryFn: fetchOverview,
        refetchInterval: POLL_MS,
        placeholderData: keepPreviousData,
    });

    // A ticking clock in state, so "updated 12s ago" counts up between refetches.
    // It holds the timestamp rather than a counter because reading Date.now()
    // during render is impure, and it starts null so the server render and the
    // first client render agree — a clock read on the server would hydrate as a
    // mismatch. The query itself still only refetches on POLL_MS.
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => {
        // The interval alone seeds it — no synchronous setState here, which would
        // cascade a second render on mount. The label reads "—" for up to one
        // second, which is hidden behind the initial loading spinner anyway.
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    const overview = data?.data;
    const degraded = Boolean(data?.degraded);
    const pill = freshnessPill(degraded ? null : (overview?.fleet.newestSignalAgeMs ?? null));

    return (
        <div className="min-h-screen bg-slate-50">
            <header className="sticky top-0 z-20 bg-[color:var(--color-brand-navy,#02314e)] text-white shadow-sm">
                <div className="mx-auto max-w-[1600px] px-6 h-14 flex items-center justify-between gap-4">
                    <div className="flex items-baseline gap-3 min-w-0">
                        <h1 className="text-sm font-semibold tracking-wide uppercase">
                            Fleet Monitor
                        </h1>
                        <span className="text-xs text-white/50 truncate hidden sm:inline">
                            IoT telemetry health
                        </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                        <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${PILL[pill.kind]}`}
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                            {pill.label}
                        </span>
                        <span className="text-xs text-white/50 tabular-nums hidden sm:inline">
                            {now && dataUpdatedAt
                                ? `updated ${relativeAge(now - dataUpdatedAt)}`
                                : "—"}
                        </span>
                        <button
                            type="button"
                            onClick={() => refetch()}
                            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                            aria-label="Refresh now"
                        >
                            <RefreshCw
                                className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
                            />
                        </button>
                        <a
                            href="/api/auth/logout"
                            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                            aria-label="Sign out"
                        >
                            <LogOut className="w-4 h-4" />
                        </a>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-[1600px] px-6 py-6 space-y-5">
                {degraded && data?.reason && (
                    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3.5">
                        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium text-amber-900">
                                Telemetry database unreachable — every figure below is unmeasured,
                                not zero.
                            </p>
                            <p className="text-xs text-amber-800 mt-0.5">{data.reason}</p>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3.5">
                        <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium text-red-900">
                                Could not load the monitor.
                            </p>
                            <p className="text-xs text-red-800 mt-0.5">
                                {error instanceof Error ? error.message : String(error)}
                            </p>
                        </div>
                    </div>
                )}

                {isLoading || !overview ? (
                    <div className="h-64 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                    </div>
                ) : (
                    <Body overview={overview} degraded={degraded} />
                )}
            </main>
        </div>
    );
}

function Body({ overview, degraded }: { overview: MonitorOverview; degraded: boolean }) {
    const { fleet, alerts, distance, mapping, attention, notMeasurable } = overview;
    const u = <T,>(v: T): T | null => (degraded ? null : v);

    // A silent vehicle is normal at one or two; it is an incident at a tenth of
    // the fleet. Scaling the threshold to fleet size keeps the tile meaningful
    // as the estate grows.
    const silentTone: Tone =
        fleet.silentOver24h === 0
            ? "good"
            : fleet.silentOver24h > Math.max(3, fleet.fleetSize * 0.05)
              ? "critical"
              : "warning";

    const liveTone: Tone =
        fleet.fleetSize === 0 ? "unknown" : fleet.livePct >= 80 ? "good" : fleet.livePct >= 60 ? "warning" : "critical";

    return (
        <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiTile
                    label="Vehicles live now"
                    value={u(fleet.liveNow)}
                    tone={liveTone}
                    status={degraded ? undefined : `${fleet.livePct}% of fleet`}
                    sub={`of ${fleet.fleetSize}`}
                />
                <KpiTile
                    label="Silent over 24h"
                    value={u(fleet.silentOver24h)}
                    tone={silentTone}
                    status={
                        degraded
                            ? undefined
                            : fleet.silentOver24h === 0
                              ? "all reporting"
                              : "was working, stopped"
                    }
                />
                <KpiTile
                    label="Never reported"
                    value={u(fleet.neverReported)}
                    tone={fleet.neverReported === 0 ? "good" : "warning"}
                    status={degraded ? undefined : "no signal on record"}
                />
                <KpiTile
                    label="Connectivity alerts"
                    value={u(alerts.open)}
                    tone={alerts.open === 0 ? "good" : "warning"}
                    status={degraded ? undefined : "open"}
                    sub={
                        alerts.distinctTypes <= 1
                            ? "offline alerts only"
                            : `${alerts.distinctTypes} alert types`
                    }
                />
            </section>

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiTile
                    label="Newest signal"
                    value={u(relativeAge(fleet.newestSignalAgeMs).replace(" ago", "")) ?? null}
                    tone="neutral"
                    status={degraded ? undefined : "anywhere in the fleet"}
                />
                <KpiTile
                    label="Reported in last 24h"
                    value={u(fleet.reportedLast24h)}
                    tone="neutral"
                    sub={`of ${fleet.fleetSize}`}
                />
                <KpiTile
                    label="Mapped to a battery"
                    value={u(mapping.mapped)}
                    tone={mapping.unmapped === 0 ? "good" : "neutral"}
                    status={
                        degraded
                            ? undefined
                            : mapping.unmapped === 0
                              ? "complete"
                              : `${mapping.unmapped} unmapped`
                    }
                    sub={`${mapping.states} states`}
                />
                <KpiTile
                    label="Distance, last 30 days"
                    value={u(Math.round(distance.totalKm30d).toLocaleString())}
                    unit="km"
                    tone="neutral"
                    status={
                        degraded || distance.avgKmPerVehicleDay === null
                            ? undefined
                            : `${distance.avgKmPerVehicleDay} km per vehicle-day`
                    }
                />
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
                <SilenceBands
                    silence={fleet.silence}
                    fleetSize={fleet.fleetSize}
                    degraded={degraded}
                />
                <SocDistribution
                    buckets={fleet.soc.buckets}
                    below20={fleet.soc.below20}
                    withReading={fleet.soc.withReading}
                    avg={fleet.soc.avg}
                    fleetSize={fleet.fleetSize}
                    degraded={degraded}
                />
            </section>

            <DistanceTrend series={distance.series14d} degraded={degraded} />

            <AttentionTable
                rows={attention}
                neverReported={fleet.neverReported}
                degraded={degraded}
            />

            {!degraded && <NotMeasurableStrip facts={notMeasurable} />}
        </>
    );
}
