"use client";

// Reports › Analyses — three look-back analyses, each driving a recurring
// decision. Numbers come from /api/reports/analyses/[id]; every analysis
// carries its own self-checks, shown as Holds / Breaks.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { LEAD_DOORS, LEAD_DOOR_LABEL } from "@/lib/leads/leadSourceVocab";
import {
    ANALYSES,
    FUNNEL_STEPS,
    barWidth,
    fmtNum,
    pct,
    periodLabel,
    rate1,
    stepBase,
    type AiScoreResult,
    type AnalysisId,
    type LeadSourceGroup,
    type LeadSourceRow,
    type LeadSourcesResult,
    type MeetingsResult,
} from "@/lib/reports/analysesShared";
import { BTN_OUTLINE, C, CARD, CheckPill, ErrorLine, Loading, PANEL, PILL, RuleLine, SELECT, Segmented, TH, getJson, Bar } from "./ui";

type Show = "share" | "step";

const AN_RULES = [
    { t: "It drives a decision someone makes every week or month.", d: "Named on the card, with who makes it." },
    { t: "It has no home on a dashboard.", d: "Usually because it counts by the date a lead came in or closed, not by what happened this month." },
    { t: "Its totals tie to a dashboard or a download.", d: "Same metric definitions; the checks shown under the controls must hold." },
    { t: "It is retired when nobody opens it for 90 days.", d: "Kept small on purpose." },
];
const AN_ELSE = [
    { t: "Asked once", d: "Ask the AI Analyst." },
    { t: "Asked twice", d: "Becomes a data download or a dashboard tile." },
    { t: "Not built", d: "A custom report builder. It produces several versions of the same number." },
];

const STEP_HEAD: Record<(typeof FUNNEL_STEPS)[number], string> = {
    not_with_sales: "Not with sales yet",
    assigned: "Assigned",
    called: "Called",
    quote_sent: "Quote sent",
    won: "Marked won",
    converted: "Converted",
};

export function AnalysesTab({ onDownload }: { onDownload: (params: Record<string, string>) => void }) {
    const [an, setAn] = useState<AnalysisId>("lead_sources");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [group, setGroup] = useState<LeadSourceGroup>("door");
    const [show, setShow] = useState<Show>("share");
    const [team, setTeam] = useState("");
    const [state, setState] = useState("");
    const [source, setSource] = useState("");
    const [manager, setManager] = useState("");
    const [city, setCity] = useState("");

    const meta = ANALYSES.find((a) => a.id === an)!;

    /** Back to the analysis's own defaults: its default period and no filters. */
    const clearFilters = () => {
        setFrom("");
        setTo("");
        setTeam("");
        setState("");
        setSource("");
        setManager("");
        setCity("");
    };
    const pick = (id: AnalysisId) => {
        setAn(id);
        // Each analysis has its own default period (90 days back, or month to date).
        clearFilters();
    };
    const filtered =
        !!(from || to) ||
        (an === "lead_sources" && !!(team || state.trim())) ||
        (an === "ai_score" && !!(team || source)) ||
        (an === "meetings" && !!(manager || city));

    const qs = useMemo(() => {
        const p = new URLSearchParams();
        if (from) p.set("from", from);
        if (to) p.set("to", to);
        if (an === "lead_sources") {
            p.set("group", group);
            if (team) p.set("team", team);
            if (state.trim()) p.set("state", state.trim());
        } else if (an === "ai_score") {
            if (source) p.set("source", source);
            if (team) p.set("team", team);
        } else {
            if (manager) p.set("manager", manager);
            if (city) p.set("city", city);
        }
        return p.toString();
    }, [an, from, to, group, team, state, source, manager, city]);

    const q = useQuery({
        queryKey: ["reports-analysis", an, qs],
        queryFn: () => getJson<LeadSourcesResult | AiScoreResult | MeetingsResult>(`/api/reports/analyses/${an}?${qs}`),
        // Keep the last answer for the SAME analysis on screen while a filter
        // change loads, so the filter controls never vanish mid-click.
        placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === an ? prev : undefined),
    });
    const data = q.data;
    const period = data?.period;

    /** The download that holds exactly these rows, when the Downloads tab can express the filters. */
    const download = (): Record<string, string> => {
        const p: Record<string, string> = { dataset: meta.dataset };
        if (an === "lead_sources" && period) {
            Object.assign(p, { from: period.from, to: period.to, contactability: "include" });
            if (state.trim()) p.state = state.trim();
        } else if (an === "meetings" && period) {
            // Visits that happened — the rows this analysis counts.
            Object.assign(p, { from: period.from, to: period.to, date_field: "visit", status: "visited" });
            if (manager) p.person = manager;
        }
        return p;
    };
    // AI score counts by the date a lead closed; the Leads download has no such
    // date, so its button opens the dataset rather than claiming the same rows.
    const dlLabel = an === "ai_score" ? "Open the Leads download" : meta.dlLabel;

    return (
        <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {ANALYSES.map((a) => {
                    const on = a.id === an;
                    return (
                        <button
                            key={a.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => pick(a.id)}
                            className={`flex min-h-[148px] flex-col items-start gap-2 rounded-2xl border-2 bg-white px-5 py-[18px] text-left shadow-[0_1px_3px_rgba(2,49,78,0.06),0_1px_2px_rgba(2,49,78,0.08)] transition ${
                                on ? "border-[#138fc6]" : "border-[#e3e8ef] hover:border-[#b8d4e6]"
                            }`}
                        >
                            <span className="flex items-center gap-2">
                                <span className={`text-[17px] font-bold ${C.ink}`}>{a.name}</span>
                                <span
                                    className={`rounded-full px-[7px] py-0.5 text-[10px] font-bold tracking-[0.04em] ${
                                        a.tag === "NEW" ? "bg-[#138fc6] text-white" : "bg-[#e7edf3] text-[#5a6877]"
                                    }`}
                                >
                                    {a.tag}
                                </span>
                            </span>
                            <span className={`text-[13.5px] leading-[1.45] ${C.text}`}>{a.decides}</span>
                            <span className={`mt-auto text-[12px] leading-[1.5] ${C.muted}`}>
                                Counts by {a.basis} · {a.cadence}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className={`${CARD} flex flex-col gap-[18px] px-4 py-5 md:px-6 md:py-[22px]`}>
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="flex flex-col gap-1">
                        <h2 className={`m-0 text-[22px] font-bold ${C.ink}`}>{meta.name}</h2>
                        <span className={`text-[14px] ${C.text}`}>{meta.decides}</span>
                        <span className={`text-[12.5px] ${C.muted}`}>Who sees it: {meta.who}</span>
                    </div>
                    <button type="button" className={BTN_OUTLINE} disabled={!period} onClick={() => onDownload(download())}>
                        <Download className="h-4 w-4" aria-hidden />
                        {dlLabel}
                    </button>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2.5">
                    <span className={PILL}>
                        <span className={C.muted}>{meta.periodLabel}</span>
                        <input
                            type="date"
                            aria-label="From"
                            value={from || period?.from || ""}
                            onChange={(e) => setFrom(e.target.value)}
                            className="bg-transparent font-semibold focus:outline-none"
                        />
                        <span className={C.muted}>–</span>
                        <input
                            type="date"
                            aria-label="To"
                            value={to || period?.to || ""}
                            onChange={(e) => setTo(e.target.value)}
                            className="bg-transparent font-semibold focus:outline-none"
                        />
                    </span>

                    {an === "lead_sources" && (
                        <>
                            <span className={`flex items-center gap-2 text-[13px] ${C.muted}`}>
                                Group by
                                <Segmented<LeadSourceGroup>
                                    ariaLabel="Group by"
                                    value={group}
                                    onChange={setGroup}
                                    options={[
                                        { value: "door", label: "Door" },
                                        { value: "origin", label: "Origin" },
                                        { value: "campaign", label: "Campaign" },
                                    ]}
                                />
                            </span>
                            <span className={`flex items-center gap-2 text-[13px] ${C.muted}`}>
                                Show
                                <Segmented<Show>
                                    ariaLabel="Show"
                                    value={show}
                                    onChange={setShow}
                                    options={[
                                        { value: "share", label: "% of leads in" },
                                        { value: "step", label: "Step to step" },
                                    ]}
                                />
                            </span>
                        </>
                    )}

                    {an !== "meetings" && (
                        <select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)} className={SELECT}>
                            <option value="">Team: All</option>
                            <option value="field">Team: Field (ASM)</option>
                            <option value="inside">Team: Inside sales</option>
                        </select>
                    )}
                    {an === "lead_sources" && (
                        <input
                            aria-label="State"
                            placeholder="State: All"
                            value={state}
                            onChange={(e) => setState(e.target.value)}
                            className={`${SELECT} w-36`}
                        />
                    )}
                    {an === "ai_score" && (
                        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} className={SELECT}>
                            <option value="">Source: All</option>
                            {LEAD_DOORS.map((d) => (
                                <option key={d} value={d}>
                                    Source: {LEAD_DOOR_LABEL[d]}
                                </option>
                            ))}
                        </select>
                    )}
                    {an === "meetings" && (
                        <>
                            <select aria-label="Sales manager" value={manager} onChange={(e) => setManager(e.target.value)} className={SELECT}>
                                <option value="">Sales manager: All</option>
                                {(data && "managers" in data ? data.managers : []).map((m) => (
                                    <option key={m.id} value={m.id}>
                                        Sales manager: {m.name}
                                        {m.inactive ? " (inactive)" : ""}
                                    </option>
                                ))}
                            </select>
                            <select aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} className={SELECT}>
                                <option value="">City: All</option>
                                {(data && "cities" in data ? data.cities : []).map((c) => (
                                    <option key={c} value={c}>
                                        City: {c}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}
                    {filtered && (
                        <button
                            type="button"
                            onClick={clearFilters}
                            className="flex min-h-[40px] items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold text-[#138fc6] hover:bg-[#e7f3fa]"
                        >
                            <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
                        </button>
                    )}
                    {period && (
                        <span className={`text-[12.5px] ${C.muted}`}>
                            {periodLabel(period)} · IST{from || to ? "" : " · default period"}
                            {q.isFetching && !q.isLoading ? " · updating…" : ""}
                        </span>
                    )}
                </div>
                {team && an !== "meetings" && (
                    <span className={`-mt-2 text-[12px] ${C.muted}`}>
                        With a team picked, only leads someone on that team holds (or held when it closed) are counted; leads nobody has held are left out.
                    </span>
                )}

                {q.isLoading && <Loading label="Counting…" />}
                {q.error && <ErrorLine message={(q.error as Error).message} />}

                {data && (
                    <>
                        <div className="flex flex-wrap gap-2.5">
                            {data.checks.map((k) => (
                                <CheckPill key={k.label} {...k} />
                            ))}
                        </div>

                        {an === "lead_sources" && "group" in data && <SourcesTable data={data} show={show} />}
                        {an === "ai_score" && !("group" in data) && !("managers" in data) && <AiTable data={data} />}
                        {an === "meetings" && "managers" in data && <MeetingsTable data={data} />}
                    </>
                )}

                <span className={`text-[12.5px] leading-[1.5] ${C.muted}`}>{meta.note}</span>

                <div className="flex flex-col gap-2 rounded-xl border border-[#e3e8ef] bg-[#f8fafc] px-4 py-3.5">
                    <span className="text-[12px] font-bold tracking-[0.08em] text-[#5a6877]">HOW PEOPLE GET HERE</span>
                    <div className="flex flex-wrap gap-2">
                        {meta.links.map((l) => (
                            <span
                                key={l.from}
                                className="flex min-h-[34px] items-center gap-1.5 rounded-full border border-[#e3e8ef] bg-white px-3 text-[12.5px] text-[#1a2733]"
                            >
                                <span className={`font-semibold ${C.ink}`}>{l.from}</span>
                                <span className={C.muted}>→ {l.to}</span>
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1.3fr_1fr]">
                <div className={`${PANEL} flex flex-col gap-2.5 px-[22px] py-5`}>
                    <h3 className={`m-0 text-[16px] font-bold ${C.ink}`}>What earns a place in Analyses</h3>
                    {AN_RULES.map((r) => (
                        <RuleLine key={r.t} title={r.t}>
                            {r.d}
                        </RuleLine>
                    ))}
                </div>
                <div className={`${PANEL} flex flex-col gap-2.5 px-[22px] py-5`}>
                    <h3 className={`m-0 text-[16px] font-bold ${C.ink}`}>Everything else</h3>
                    {AN_ELSE.map((r) => (
                        <div key={r.t} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[1.5]">
                            <span className="font-bold text-[#165e73]">{r.t}</span>
                            <span>{r.d}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ──────────────────────────────── Tables ────────────────────────────────────

const SRC_GRID =
    "grid grid-cols-[minmax(150px,1.6fr)_repeat(7,minmax(72px,1fr))_minmax(110px,1.2fr)_minmax(140px,1.5fr)] gap-3";

function SourcesTable({ data, show }: { data: LeadSourcesResult; show: Show }) {
    const all = [data.total, ...data.rows];
    const best = Math.max(0, ...data.rows.map((r) => (r.leads_in ? r.converted / r.leads_in : 0)));
    const groupHead = data.group === "door" ? "SOURCE (DOOR)" : data.group === "origin" ? "SOURCE (ORIGIN)" : "CAMPAIGN";
    const row = (r: LeadSourceRow, isTotal: boolean) => {
        const weight = isTotal ? "font-bold" : "font-medium";
        const rate = r.leads_in ? r.converted / r.leads_in : 0;
        return (
            <div
                key={r.key ?? "__none__"}
                role="row"
                className={`${SRC_GRID} min-h-[54px] items-center border-b border-[#f1f4f7] px-3 py-1.5 ${isTotal ? "bg-[#f8fafc]" : ""}`}
            >
                <span className="flex flex-col gap-px">
                    <span className={`text-[14px] ${weight} ${C.ink}`}>{r.label}</span>
                    {r.sub && <span className={`text-[11.5px] ${C.muted}`}>{r.sub}</span>}
                </span>
                <span className={`text-right text-[14px] tabular-nums ${weight}`}>{fmtNum(r.leads_in)}</span>
                {FUNNEL_STEPS.map((s) => (
                    <span key={s} className="flex flex-col items-end gap-px">
                        <span className={`text-[14px] tabular-nums ${weight}`}>{fmtNum(r[s])}</span>
                        <span className={`text-[11px] tabular-nums ${C.muted}`}>{pct(r[s], stepBase(r, s, show))}</span>
                    </span>
                ))}
                <span className="flex flex-col gap-[5px]">
                    <span className={`text-right text-[14px] font-bold tabular-nums ${C.ink}`}>{rate1(r.converted, r.leads_in)}</span>
                    <Bar width={barWidth(rate, best)} color={isTotal ? "#02314e" : "#138fc6"} />
                </span>
                <span className="flex flex-col gap-px">
                    <span className="text-[14px] tabular-nums">{fmtNum(r.lost)}</span>
                    <span className={`text-[11.5px] ${C.muted}`}>{r.lost && r.top_lost_reason ? `Top: ${r.top_lost_reason}` : ""}</span>
                </span>
            </div>
        );
    };
    return (
        <div className="overflow-x-auto">
            <div role="table" aria-label="Lead sources" className="flex min-w-[1100px] flex-col">
                <div role="row" className={`${SRC_GRID} items-end border-b border-[#e3e8ef] px-3 pb-2 ${TH}`}>
                    <span>{groupHead}</span>
                    <span className="text-right">Leads in</span>
                    {FUNNEL_STEPS.map((s) => (
                        <span key={s} className="text-right">
                            {STEP_HEAD[s]}
                        </span>
                    ))}
                    <span className="text-right">Lead → dealer</span>
                    <span>Lost · top reason</span>
                </div>
                {all.map((r, i) => row(r, i === 0))}
                {data.rows.length === 0 && <div className={`px-3 py-6 text-[13px] ${C.muted}`}>No leads were created in this period.</div>}
            </div>
        </div>
    );
}

const AI_GRID = "grid grid-cols-[minmax(110px,1.2fr)_repeat(3,minmax(70px,0.8fr))_minmax(180px,2.2fr)] gap-3.5";

function AiTable({ data }: { data: AiScoreResult }) {
    const best = Math.max(0, ...data.rows.map((r) => (r.closed ? r.converted / r.closed : 0)));
    const rows = [...data.rows, data.total];
    return (
        <div className="overflow-x-auto">
            <div role="table" aria-label="Conversion by AI score band" className="flex min-w-[640px] max-w-[980px] flex-col">
                <div role="row" className={`${AI_GRID} items-end border-b border-[#e3e8ef] px-3 pb-2 ${TH}`}>
                    <span>AI score band</span>
                    <span className="text-right">Converted</span>
                    <span className="text-right">Lost</span>
                    <span className="text-right">Closed</span>
                    <span>Conversion (converted ÷ closed)</span>
                </div>
                {rows.map((r) => {
                    const isTotal = r.band === "all";
                    const w = isTotal ? "font-bold" : "font-medium";
                    return (
                        <div
                            key={r.band}
                            role="row"
                            className={`${AI_GRID} min-h-[48px] items-center border-b border-[#f1f4f7] px-3 text-[14px] tabular-nums ${isTotal ? "bg-[#f8fafc]" : ""}`}
                        >
                            <span className={`${w} ${C.ink}`}>{r.label}</span>
                            <span className={`text-right ${w}`}>{fmtNum(r.converted)}</span>
                            <span className={`text-right ${w}`}>{fmtNum(r.lost)}</span>
                            <span className={`text-right ${w}`}>{fmtNum(r.closed)}</span>
                            <span className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-2.5">
                                <span className="flex h-2 overflow-hidden rounded-full bg-[#eef2f6]">
                                    <span
                                        className="rounded-full"
                                        style={{
                                            width: `${barWidth(r.closed ? r.converted / r.closed : 0, best)}%`,
                                            background: isTotal ? "#02314e" : "#138fc6",
                                        }}
                                    />
                                </span>
                                <span className={`text-right font-bold ${C.ink}`}>{rate1(r.converted, r.closed)}</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const MEET_GRID = "grid grid-cols-[minmax(150px,1.4fr)_minmax(110px,1.1fr)_repeat(8,minmax(60px,0.7fr))] gap-3";
const MEET_COLS = [
    { key: "visits", head: "Visits", hint: "One person at one dealer on one day, visit happened" },
    { key: "dealers", head: "Dealers", hint: "Different dealers visited" },
    { key: "fresh", head: "Fresh", hint: "Visit on the dealer's first-ever visit day" },
    { key: "repeat", head: "Repeat", hint: "Every other visit" },
    { key: "planned", head: "Planned", hint: "Booked for a day in this period, not logged as visited yet" },
    { key: "ground", head: "Ground", hint: "In person" },
    { key: "calling", head: "Calling", hint: "Meeting held over a call" },
    { key: "whatsapp", head: "WhatsApp", hint: "Meeting held over WhatsApp" },
] as const;

function MeetingsTable({ data }: { data: MeetingsResult }) {
    const rows = [data.total, ...data.rows];
    return (
        <div className="flex flex-col gap-2">
            <div className="overflow-x-auto">
                <div role="table" aria-label="Meetings by sales manager and city" className="flex min-w-[980px] flex-col">
                    <div role="row" className={`${MEET_GRID} items-end border-b border-[#e3e8ef] px-3 pb-2 ${TH}`}>
                        <span>Sales manager</span>
                        <span>City</span>
                        {MEET_COLS.map((c) => (
                            <span key={c.key} className="text-right" title={c.hint}>
                                {c.head}
                            </span>
                        ))}
                    </div>
                    {rows.map((r, i) => {
                        const idle = i > 0 && r.visits === 0 && r.planned === 0;
                        return (
                            <div
                                key={`${r.manager_id ?? r.manager}-${r.city}-${i}`}
                                role="row"
                                className={`${MEET_GRID} min-h-[46px] items-center border-b border-[#f1f4f7] px-3 text-[14px] tabular-nums ${
                                    i === 0 ? "bg-[#f8fafc] font-bold" : "font-medium"
                                } ${idle ? "text-[#8a96a3]" : ""}`}
                            >
                                <span className={idle ? "" : C.ink}>
                                    {r.manager}
                                    {r.inactive && <span className={`ml-1 text-[11.5px] font-normal ${C.muted}`}>(inactive)</span>}
                                </span>
                                <span>{r.city}</span>
                                {MEET_COLS.map((c) => (
                                    <span key={c.key} className="text-right">
                                        {fmtNum(r[c.key])}
                                    </span>
                                ))}
                            </div>
                        );
                    })}
                </div>
            </div>
            {data.mode_not_captured && (
                <span className={`text-[12px] ${C.muted}`}>
                    Meeting type is not captured yet: every visit is recorded as Ground, so Calling and WhatsApp read 0 until the visit form asks for it.
                </span>
            )}
        </div>
    );
}
