"use client";

// Sales Head › Team performance (26 Nov task). The team as one: visits, Hot /
// Warm / Cold, quotations, dealers onboarded, lead conversion and progress
// against the team's targets, then each person with their target status
// (posted / pushed / accepted — why a target does or does not show), and the
// downloadable team report. Data: /api/admin/reports/team-performance, which
// reads the same builders as the scorecard below, so the two cannot disagree.

import React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { InfoTip } from "@/components/ui/info-tip";
import { DashCard, LoadingBlock, NotAvailable, ProgressBar, TABLE_HEAD, inr, num, toneForPct, toneText } from "@/components/dashboard/redesign/primitives";
import type { TeamPerformance, TeamPerson } from "@/lib/dashboard/teamPerformance";
import { monthLabel, type TargetState, type TeamSegment } from "@/lib/dashboard/teamPerformanceRules";

type Props = {
    from: string;
    to: string;
    state?: string;
    city?: string;
    businessType?: string;
    team: TeamSegment;
    /** Show only this person on the rest of the screen. */
    onPickPerson?: (userId: string) => void;
};

const STATE_TONE: Record<TargetState, string> = {
    accepted: "bg-success-bg text-success",
    partly_accepted: "bg-[#fff6e0] text-[#8a5a00]",
    awaiting_acceptance: "bg-[#fff6e0] text-[#8a5a00]",
    correction_asked: "bg-danger-bg text-danger",
    with_sales_head: "bg-danger-bg text-danger",
    none: "bg-[#eef1f4] text-ink-muted",
};

export function TeamPerformanceCard({ from, to, state, city, businessType, team, onPickPerson }: Props) {
    const qs = new URLSearchParams({ from, to, team });
    if (state) qs.set("state", state);
    if (city) qs.set("city", city);
    if (businessType) qs.set("business_type", businessType);

    const q = useQuery<TeamPerformance>({
        queryKey: ["sales-head-ops", "team-performance", qs.toString()],
        queryFn: async () => {
            const res = await fetch(`/api/admin/reports/team-performance?${qs}`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json || json.success === false) throw new Error(json?.error?.message ?? "Could not load team performance");
            return json.data as TeamPerformance;
        },
        placeholderData: (prev) => prev,
        retry: false,
    });
    const d = q.data;
    const t = d?.team;

    const download = (format: "xlsx" | "csv") => `/api/admin/reports/team-performance?${qs}&format=${format}`;
    const months = d ? monthLabel(d.target_month) : "";

    return (
        <DashCard
            title="Team performance"
            caption={
                <>
                    {t ? `${num(t.people)} ${t.people === 1 ? "person" : "people"} · ${from === to ? from : `${from} → ${to}`}` : "The whole team for the selected days"}
                    <InfoTip className="ml-1">
                        {
                            "Visits, calls, quotations, converted, KYC and revenue are for the selected days. Hot / Warm / Cold are the open rated leads each person owns today. Dealers onboarded = onboarding approved in the period, credited to the salesperson on the application. Conversion = Converted ÷ (Converted + Lost) of the leads closed in the period. Targets are the month of the To date."
                        }
                    </InfoTip>
                </>
            }
            action={
                <div className="flex items-center gap-2">
                    <a
                        href={download("xlsx")}
                        download
                        data-testid="team-report-xlsx"
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] bg-brand-navy px-3 text-[13px] font-semibold text-white hover:opacity-90"
                        title="Team activity and performance: Summary, People and Targets sheets"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden /> Download report
                    </a>
                    <a
                        href={download("csv")}
                        download
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-semibold text-brand-navy hover:bg-bg"
                    >
                        CSV
                    </a>
                </div>
            }
        >
            {!d || !t ? (
                q.isLoading ? <LoadingBlock /> : <NotAvailable reason={(q.error as Error | null)?.message} />
            ) : (
                <div className="flex flex-col gap-5" data-testid="team-performance">
                    {/* Team KPIs */}
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                        <Kpi label="Total visits" value={num(t.visits)} sub={`${num(t.unique_visits)} dealers visited`} />
                        <Kpi label="New dealer visits" value={num(t.new_visits)} sub="Dealers new to iTarang" />
                        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
                            <span className="text-[13px] font-semibold">Hot · Warm · Cold</span>
                            <span className="text-[22px] font-bold tabular-nums">
                                <span className="text-danger">{num(t.hot)}</span>
                                <span className="text-ink-muted"> · </span>
                                <span className="text-[#b26b00]">{num(t.warm)}</span>
                                <span className="text-ink-muted"> · </span>
                                <span className="text-brand-sky">{num(t.cold)}</span>
                            </span>
                            <span className="text-[12.5px] text-ink-muted">Open leads today · {num(t.new_hot)} new hot</span>
                        </div>
                        <Kpi label="Quotations raised" value={num(t.quotes_issued)} sub={`${num(t.quote_revisions)} revisions`} />
                        <Kpi label="Dealers onboarded" value={num(t.dealers_onboarded)} sub="Onboarding approved" />
                        <Kpi
                            label="Lead conversion"
                            value={t.conversion_pct == null ? "—" : `${t.conversion_pct}%`}
                            sub={`${num(t.converted)} converted · ${num(t.lost)} lost`}
                        />
                    </div>

                    {/* Team progress against target */}
                    <div className="flex flex-col gap-2">
                        <span className={TABLE_HEAD}>
                            Progress against team target · {months} · to date ({d.working_days.elapsed} of {d.working_days.total} working days)
                        </span>
                        {d.team_targets.length === 0 ? (
                            <span className="text-[13px] text-ink-muted">
                                No target is in force for this team in {months}.{" "}
                                <Link href={`/admin/targets?month=${d.target_month}`} className="font-semibold text-brand-sky hover:underline">
                                    Open Targets
                                </Link>
                            </span>
                        ) : (
                            <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 md:grid-cols-2">
                                {d.team_targets.map((r) => {
                                    const money = r.kind === "money";
                                    const f = (v: number) => (money ? inr(v) : num(v));
                                    const tone = toneForPct(r.pct);
                                    return (
                                        <div key={r.metric} className="flex flex-col gap-1">
                                            <div className="flex items-baseline justify-between gap-2 text-[13px]">
                                                <span className="truncate font-semibold">
                                                    {r.label} <span className="font-normal text-ink-muted">· {r.people} {r.people === 1 ? "person" : "people"}</span>
                                                </span>
                                                <span className="shrink-0 tabular-nums">
                                                    <span className="font-bold">{r.actual == null ? "not measured" : f(r.actual)}</span>
                                                    <span className="text-ink-muted"> / {f(r.mtd_target)}</span>{" "}
                                                    {r.pct != null && <span className={`font-bold ${toneText(tone)}`}>{r.pct}%</span>}
                                                </span>
                                            </div>
                                            <ProgressBar pct={r.pct == null ? 0 : Math.min((r.pct / 120) * 100, 100)} tone={tone} height={6} />
                                            <span className="text-[11.5px] text-ink-muted">
                                                {r.kind === "per_day" ? `${f(r.monthly_target)} a day` : `${f(r.monthly_target)} for the month`}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Per person, with target status */}
                    <PeopleGrid people={d.people} month={d.target_month} onPickPerson={onPickPerson} />

                    <TargetStateSummary states={d.target_states} month={months} targetMonth={d.target_month} />
                </div>
            )}
        </DashCard>
    );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
    return (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
            <span className="text-[13px] font-semibold">{label}</span>
            <span className="text-[26px] font-bold text-brand-navy tabular-nums">{value}</span>
            <span className="text-[12.5px] text-ink-muted">{sub}</span>
        </div>
    );
}

const GRID = "grid-cols-[minmax(150px,1.4fr)_repeat(6,minmax(0,1fr))_minmax(170px,1.3fr)]";

function PeopleGrid({ people, month, onPickPerson }: { people: TeamPerson[]; month: string; onPickPerson?: (id: string) => void }) {
    if (people.length === 0) return <NotAvailable empty reason="No one in this team." />;
    return (
        <div className="overflow-x-auto">
            <div className="min-w-[900px]">
                <div className={`grid ${GRID} gap-2.5 border-b border-border pb-2 ${TABLE_HEAD}`}>
                    <span>Person</span>
                    <span className="text-right">Visits (new)</span>
                    <span className="text-right">Hot · Warm · Cold</span>
                    <span className="text-right">Quotations</span>
                    <span className="text-right">Onboarded</span>
                    <span className="text-right">Converted · Lost</span>
                    <span className="text-right">Conversion</span>
                    <span>Target ({monthLabel(month)})</span>
                </div>
                {people.map((p) => (
                    <div key={p.user_id} className={`grid ${GRID} min-h-[42px] items-center gap-2.5 border-b border-[#f1f4f7] text-[13px] tabular-nums`}>
                        <span className="flex min-w-0 flex-col">
                            {onPickPerson ? (
                                <button
                                    type="button"
                                    onClick={() => onPickPerson(p.user_id)}
                                    className="truncate text-left font-semibold text-ink hover:text-brand-sky"
                                    title="Show only this person"
                                >
                                    {p.name ?? "Unnamed"}
                                </button>
                            ) : (
                                <span className="truncate font-semibold">{p.name ?? "Unnamed"}</span>
                            )}
                            <span className="truncate text-[11.5px] text-ink-muted">
                                {p.segment === "inside" ? "ISR" : p.role === "sales_manager" ? "Sales manager" : "ASM"}
                                {p.manager ? ` · reports to ${p.manager}` : ""}
                            </span>
                        </span>
                        <span className="text-right">
                            {num(p.visits)} <span className="text-ink-muted">({num(p.new_visits)})</span>
                        </span>
                        <span className="text-right">
                            {num(p.hot)} · {num(p.warm)} · {num(p.cold)}
                        </span>
                        <span className="text-right">{num(p.quotes_issued)}</span>
                        <span className="text-right">{num(p.dealers_onboarded)}</span>
                        <span className="text-right">
                            {num(p.converted)} · {num(p.lost)}
                        </span>
                        <span className="text-right">{p.conversion_pct == null ? "—" : `${p.conversion_pct}%`}</span>
                        <span className="flex items-center gap-1.5">
                            <span className={`truncate rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${STATE_TONE[p.target_status.state]}`} data-testid="target-status">
                                {p.target_status.label}
                            </span>
                            <InfoTip>{p.target_status.detail}</InfoTip>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function TargetStateSummary({ states, month, targetMonth }: { states: TeamPerformance["target_states"]; month: string; targetMonth: string }) {
    const parts = [
        states.with_sales_head ? `${num(states.with_sales_head)} posted by the CEO but not pushed yet (the scorecard shows "no target" for them)` : null,
        states.none ? `${num(states.none)} with no target for ${month}` : null,
        states.awaiting_acceptance + states.partly_accepted
            ? `${num(states.awaiting_acceptance + states.partly_accepted)} sent but not fully accepted (already counted)`
            : null,
        states.correction_asked ? `${num(states.correction_asked)} asked for a correction` : null,
    ].filter(Boolean);
    return (
        <p className="text-xs leading-relaxed text-ink-muted">
            {parts.length === 0 ? `Every target for ${month} is sent and accepted. ` : `Targets: ${parts.join("; ")}. `}
            Targets are set per month and read for the month of the To date; only targets sent to the member count.{" "}
            <Link href={`/admin/targets?month=${targetMonth}`} className="font-semibold text-brand-sky hover:underline">
                Open Targets and the posting history
            </Link>
        </p>
    );
}
