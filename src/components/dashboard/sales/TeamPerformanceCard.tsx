"use client";

// Sales Head › Team performance (26 Nov task). The team as one: visits, Hot /
// Warm / Cold, quotations, dealers onboarded, lead conversion and progress
// against the team's targets, then each person with their target status
// (posted / pushed / accepted — why a target does or does not show), and the
// downloadable team report. Data: /api/admin/reports/team-performance, which
// reads the same builders as the scorecard below, so the two cannot disagree.
//
// Every number opens the rows behind it (SalesDrillModal → salesDrill.ts),
// for the people it counts. "Manager's team" narrows the card to one manager
// and their direct reports.

import React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { InfoTip } from "@/components/ui/info-tip";
import { DashCard, LoadingBlock, NotAvailable, ProgressBar, TABLE_HEAD, inr, num, toneForPct, toneText } from "@/components/dashboard/redesign/primitives";
import type { TeamPerformance, TeamPerson } from "@/lib/dashboard/teamPerformance";
import {
    monthLabel,
    TARGET_METRIC_DRILL,
    TEAM_COUNT_DRILL,
    type TargetState,
    type TeamSegment,
    type TeamTargetRow,
} from "@/lib/dashboard/teamPerformanceRules";
import { SalesDrillModal, type SalesDrillTarget } from "./SalesDrillModal";

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

type CountKey = keyof typeof TEAM_COUNT_DRILL;

const STATE_TONE: Record<TargetState, string> = {
    accepted: "bg-success-bg text-success",
    partly_accepted: "bg-[#fff6e0] text-[#8a5a00]",
    awaiting_acceptance: "bg-[#fff6e0] text-[#8a5a00]",
    correction_asked: "bg-danger-bg text-danger",
    with_sales_head: "bg-danger-bg text-danger",
    none: "bg-[#eef1f4] text-ink-muted",
};

const SELECT =
    "min-h-9 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";

export function TeamPerformanceCard({ from, to, state, city, businessType, team, onPickPerson }: Props) {
    const [managerId, setManagerId] = React.useState("");
    const [drill, setDrill] = React.useState<SalesDrillTarget | null>(null);

    const qs = new URLSearchParams({ from, to, team });
    if (state) qs.set("state", state);
    if (city) qs.set("city", city);
    if (businessType) qs.set("business_type", businessType);
    if (managerId) qs.set("manager_id", managerId);

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
    const teamWord = d?.filters.manager_name ? `${d.filters.manager_name}'s team` : "Team";

    // ── Drills ──────────────────────────────────────────────────────────────
    /** The card's filters (dates + lead scope) and the people a number counts. */
    const drillQs = (kind: string, persons: string[], window?: { from: string; to: string }) => {
        const p = new URLSearchParams({ kind, from: window?.from ?? from, to: window?.to ?? to });
        // Target actuals ignore the lead filters (as on Admin › Targets), so their rows do too.
        if (!window) {
            if (state) p.set("state", state);
            if (city) p.set("city", city);
            if (businessType) p.set("business_type", businessType);
        }
        p.set("persons", persons.length ? persons.join(",") : "__nobody__");
        return p.toString();
    };
    const everyone = d?.people.map((p) => p.user_id) ?? [];
    /** A team number: the rows for everyone on the card. */
    const openTeam = (key: CountKey, label: string, count: number) => {
        if (count > 0) setDrill({ title: `${teamWord} — ${label}`, count, query: drillQs(TEAM_COUNT_DRILL[key], everyone) });
    };
    /** One person's number. */
    const openPerson = (p: TeamPerson, key: CountKey, label: string) => {
        const count = Number(p[key] ?? 0);
        if (count > 0) setDrill({ title: `${p.name ?? "Unnamed"} — ${label}`, count, query: drillQs(TEAM_COUNT_DRILL[key], [p.user_id]) });
    };
    /** A target row: the rows behind the actual, for the people with that target, over the target month. */
    const targetDrill = (r: TeamTargetRow) => {
        const kind = TARGET_METRIC_DRILL[r.metric];
        if (!kind || !d?.target_window || r.actual == null || r.actual <= 0) return undefined;
        const exact = r.kind === "count";
        return () =>
            setDrill({
                title: `${teamWord} — ${r.label}${r.kind === "per_day" ? " (the calls behind the daily average)" : ""}, ${monthLabel(d.target_month)} to date`,
                count: exact ? r.actual! : -1,
                query: drillQs(kind, r.user_ids, d.target_window!),
            });
    };

    return (
        <DashCard
            title="Team performance"
            caption={
                <>
                    {t
                        ? `${d?.filters.manager_name ? `${d.filters.manager_name} and direct reports · ` : ""}${num(t.people)} ${t.people === 1 ? "person" : "people"} · ${from === to ? from : `${from} → ${to}`}`
                        : "The whole team for the selected days"}
                    <InfoTip className="ml-1">
                        {
                            "Click any number to see the dealers or leads behind it. Visits, calls, quotations, converted, KYC and revenue are for the selected days. Hot / Warm / Cold are the open rated leads each person owns today. Dealers onboarded = onboarding approved in the period, credited to the salesperson on the application. Conversion = Converted ÷ (Converted + Lost) of the leads closed in the period. Targets are the month of the To date."
                        }
                    </InfoTip>
                </>
            }
            action={
                <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[13px] text-ink-muted">
                        Manager&apos;s team
                        <select
                            aria-label="Show one manager's team"
                            data-testid="team-manager"
                            value={managerId}
                            onChange={(e) => setManagerId(e.target.value)}
                            className={`${SELECT} max-w-[200px]`}
                        >
                            <option value="">Everyone</option>
                            {(d?.managers ?? []).map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.name ?? "Unnamed"} ({m.members} {m.members === 1 ? "report" : "reports"})
                                </option>
                            ))}
                        </select>
                    </label>
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
                    {/* Team KPIs — every number opens its rows */}
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                        <Kpi label="Total visits">
                            <Big value={t.visits} onClick={() => openTeam("visits", "visits", t.visits)} />
                            <Sub>
                                <N value={t.unique_visits} onClick={() => openTeam("unique_visits", "dealers visited", t.unique_visits)} /> dealers visited
                            </Sub>
                        </Kpi>
                        <Kpi label="New dealer visits">
                            <Big value={t.new_visits} onClick={() => openTeam("new_visits", "dealers new to iTarang", t.new_visits)} />
                            <Sub>Dealers new to iTarang</Sub>
                        </Kpi>
                        <Kpi label="Hot · Warm · Cold">
                            <span className="text-[22px] font-bold tabular-nums">
                                <N value={t.hot} className="text-danger" onClick={() => openTeam("hot", "Hot leads", t.hot)} />
                                <span className="text-ink-muted"> · </span>
                                <N value={t.warm} className="text-[#b26b00]" onClick={() => openTeam("warm", "Warm leads", t.warm)} />
                                <span className="text-ink-muted"> · </span>
                                <N value={t.cold} className="text-brand-sky" onClick={() => openTeam("cold", "Cold leads", t.cold)} />
                            </span>
                            <Sub>
                                Open leads today · <N value={t.new_hot} onClick={() => openTeam("new_hot", "new Hot leads", t.new_hot)} /> new hot
                            </Sub>
                        </Kpi>
                        <Kpi label="Quotations raised">
                            <Big value={t.quotes_issued} onClick={() => openTeam("quotes_issued", "quotations raised", t.quotes_issued)} />
                            <Sub>
                                <N value={t.quote_revisions} onClick={() => openTeam("quote_revisions", "quote revisions", t.quote_revisions)} /> revisions
                            </Sub>
                        </Kpi>
                        <Kpi label="Dealers onboarded">
                            <Big value={t.dealers_onboarded} onClick={() => openTeam("dealers_onboarded", "dealers onboarded", t.dealers_onboarded)} />
                            <Sub>Onboarding approved</Sub>
                        </Kpi>
                        <Kpi label="Lead conversion">
                            <span className="text-[26px] font-bold text-brand-navy tabular-nums">{t.conversion_pct == null ? "—" : `${t.conversion_pct}%`}</span>
                            <Sub>
                                <N value={t.converted} onClick={() => openTeam("converted", "converted", t.converted)} /> converted ·{" "}
                                <N value={t.lost} onClick={() => openTeam("lost", "lost", t.lost)} /> lost
                            </Sub>
                        </Kpi>
                    </div>

                    {/* Team progress against target */}
                    <div className="flex flex-col gap-2">
                        <span className={TABLE_HEAD}>
                            Progress against {d.filters.manager_name ? `${d.filters.manager_name}'s team` : "team"} target · {months} · to date ({d.working_days.elapsed} of{" "}
                            {d.working_days.total} working days)
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
                                    const open = targetDrill(r);
                                    return (
                                        <div key={r.metric} className="flex flex-col gap-1">
                                            <div className="flex items-baseline justify-between gap-2 text-[13px]">
                                                <span className="truncate font-semibold">
                                                    {r.label} <span className="font-normal text-ink-muted">· {r.people} {r.people === 1 ? "person" : "people"}</span>
                                                </span>
                                                <span className="shrink-0 tabular-nums">
                                                    <span className="font-bold">
                                                        {r.actual == null ? (
                                                            "not measured"
                                                        ) : open ? (
                                                            <button
                                                                type="button"
                                                                onClick={open}
                                                                title="See the rows behind this number"
                                                                data-testid={`target-actual-${r.metric}`}
                                                                className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-brand-sky"
                                                            >
                                                                {f(r.actual)}
                                                            </button>
                                                        ) : (
                                                            f(r.actual)
                                                        )}
                                                    </span>
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
                    <PeopleGrid people={d.people} month={d.target_month} onPickPerson={onPickPerson} openPerson={openPerson} />

                    <TargetStateSummary states={d.target_states} month={months} targetMonth={d.target_month} />
                </div>
            )}
            {drill && <SalesDrillModal target={drill} onClose={() => setDrill(null)} />}
        </DashCard>
    );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
            <span className="text-[13px] font-semibold">{label}</span>
            {children}
        </div>
    );
}

function Sub({ children }: { children: React.ReactNode }) {
    return <span className="text-[12.5px] text-ink-muted">{children}</span>;
}

/** A number that opens its rows; plain text at 0 (nothing behind it). */
function N({ value, onClick, className = "" }: { value: number; onClick: () => void; className?: string }) {
    if (!value) return <span className={className}>{num(value)}</span>;
    return (
        <button
            type="button"
            onClick={onClick}
            title="See the rows behind this number"
            className={`cursor-pointer tabular-nums underline decoration-dotted underline-offset-2 hover:text-brand-sky ${className}`}
        >
            {num(value)}
        </button>
    );
}

function Big({ value, onClick }: { value: number; onClick: () => void }) {
    return (
        <span className="text-[26px] font-bold text-brand-navy tabular-nums">
            <N value={value} onClick={onClick} />
        </span>
    );
}

const GRID = "grid-cols-[minmax(150px,1.4fr)_repeat(6,minmax(0,1fr))_minmax(170px,1.3fr)]";

function PeopleGrid({
    people,
    month,
    onPickPerson,
    openPerson,
}: {
    people: TeamPerson[];
    month: string;
    onPickPerson?: (id: string) => void;
    openPerson: (p: TeamPerson, key: CountKey, label: string) => void;
}) {
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
                {people.map((p) => {
                    const cell = (key: CountKey, label: string, className = "") => (
                        <N value={Number(p[key] ?? 0)} className={className} onClick={() => openPerson(p, key, label)} />
                    );
                    return (
                        <div key={p.user_id} className={`grid ${GRID} min-h-[42px] items-center gap-2.5 border-b border-[#f1f4f7] text-[13px] tabular-nums`}>
                            <span className="flex min-w-0 flex-col">
                                {onPickPerson ? (
                                    <button
                                        type="button"
                                        onClick={() => onPickPerson(p.user_id)}
                                        className="truncate text-left font-semibold text-ink hover:text-brand-sky"
                                        title="Show only this person on the rest of the page"
                                    >
                                        {p.name ?? "Unnamed"}
                                    </button>
                                ) : (
                                    <span className="truncate font-semibold">{p.name ?? "Unnamed"}</span>
                                )}
                                <span className="truncate text-[11.5px] text-ink-muted">
                                    {p.segment === "inside" ? "ISR" : p.role === "sales_manager" ? "Sales manager" : p.segment === "field" ? "ASM" : (p.role ?? "").replace(/_/g, " ")}
                                    {p.manager ? ` · reports to ${p.manager}` : ""}
                                </span>
                            </span>
                            <span className="text-right">
                                {cell("visits", "visits")} <span className="text-ink-muted">({cell("new_visits", "dealers new to iTarang")})</span>
                            </span>
                            <span className="text-right">
                                {cell("hot", "Hot leads")} · {cell("warm", "Warm leads")} · {cell("cold", "Cold leads")}
                            </span>
                            <span className="text-right">{cell("quotes_issued", "quotations raised")}</span>
                            <span className="text-right">{cell("dealers_onboarded", "dealers onboarded")}</span>
                            <span className="text-right">
                                {cell("converted", "converted")} · {cell("lost", "lost")}
                            </span>
                            <span className="text-right">{p.conversion_pct == null ? "—" : `${p.conversion_pct}%`}</span>
                            <span className="flex items-center gap-1.5">
                                <span className={`truncate rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${STATE_TONE[p.target_status.state]}`} data-testid="target-status">
                                    {p.target_status.label}
                                </span>
                                <InfoTip>{p.target_status.detail}</InfoTip>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function TargetStateSummary({ states, month, targetMonth }: { states: TeamPerformance["target_states"]; month: string; targetMonth: string }) {
    const parts = [
        states.with_sales_head ? `${num(states.with_sales_head)} posted by the CEO but not pushed yet (the scorecard shows "not pushed yet" for them)` : null,
        states.none ? `${num(states.none)} with no target for ${month}` : null,
        states.awaiting_acceptance + states.partly_accepted
            ? `${num(states.awaiting_acceptance + states.partly_accepted)} sent but not fully accepted (already counted)`
            : null,
        states.correction_asked ? `${num(states.correction_asked)} asked for a correction` : null,
    ].filter(Boolean);
    return (
        <p className="text-xs leading-relaxed text-ink-muted">
            {parts.length === 0 ? `Every target for ${month} is sent and accepted. ` : `Targets: ${parts.join("; ")}. `}
            Targets are set per month and read for the month of the To date; only targets sent to the member count. Click any underlined number for its
            rows.{" "}
            <Link href={`/admin/targets?month=${targetMonth}`} className="font-semibold text-brand-sky hover:underline">
                Open Targets and the posting history
            </Link>
        </p>
    );
}
