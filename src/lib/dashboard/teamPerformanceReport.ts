/**
 * Sales Head › Team performance — the downloadable report (26 Nov task 5).
 * Pure: turns a TeamPerformance into sheets. The route writes them as one
 * .xlsx (Summary, People, Targets) or, for ?format=csv, the People sheet.
 *
 * "Same numbers as the screen" is the contract: every cell comes from the
 * TeamPerformance object the card renders.
 */
import type { TeamPerformance, TeamPerson } from "./teamPerformance";
import { monthLabel } from "./teamPerformanceRules";

export type Cell = string | number | null;
export interface ReportSheet {
    name: string;
    headers: string[];
    rows: Cell[][];
}

const TEAM_LABEL = { all: "Everyone", field: "Field (ASM)", inside: "Inside sales (ISR)" } as const;
const ROLE_LABEL: Record<string, string> = { asm: "ASM", sales_manager: "Sales manager", inside_sales_rep: "Inside sales (ISR)" };
const STATUS_LABEL: Record<string, string> = {
    draft: "CEO draft",
    pending_approval: "Posted — not pushed to member",
    pushed: "Sent — not accepted yet",
    accepted: "Accepted",
    rejected: "Old-flow reject — push again",
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "");
const pct = (n: number | null) => (n == null ? "" : `${n}%`);

const PEOPLE_HEADERS = [
    "Person",
    "Role",
    "Reports to",
    "Total visits",
    "Dealers visited",
    "New dealer visits",
    "Calls",
    "Hot leads",
    "Warm leads",
    "Cold leads",
    "New hot in period",
    "Quotations raised",
    "Quote revisions",
    "Dealers onboarded",
    "Converted",
    "Lost",
    "Conversion %",
    "KYC submitted",
    "Revenue (INR)",
    "Target status",
    "Targets in force",
    "Targets accepted",
    "Last pushed",
    "Last accepted",
];

function personRow(p: TeamPerson): Cell[] {
    return [
        p.name ?? p.user_id,
        ROLE_LABEL[p.role ?? ""] ?? p.role ?? "",
        p.manager ?? "",
        p.visits,
        p.unique_visits,
        p.new_visits,
        p.calls,
        p.hot,
        p.warm,
        p.cold,
        p.new_hot,
        p.quotes_issued,
        p.quote_revisions,
        p.dealers_onboarded,
        p.converted,
        p.lost,
        pct(p.conversion_pct),
        p.kyc_submitted,
        p.revenue,
        p.target_status.label,
        p.target_status.in_force,
        p.target_status.accepted,
        day(p.target_status.last_pushed_at),
        day(p.target_status.last_accepted_at),
    ];
}

/** The People sheet: one row per person and a Team total row. */
export function peopleSheet(d: TeamPerformance): ReportSheet {
    const t = d.team;
    return {
        name: "People",
        headers: PEOPLE_HEADERS,
        rows: [
            ...d.people.map(personRow),
            [
                `Team total (${t.people})`,
                "",
                "",
                t.visits,
                t.unique_visits,
                t.new_visits,
                t.calls,
                t.hot,
                t.warm,
                t.cold,
                t.new_hot,
                t.quotes_issued,
                t.quote_revisions,
                t.dealers_onboarded,
                t.converted,
                t.lost,
                pct(t.conversion_pct),
                t.kyc_submitted,
                t.revenue,
                "",
                d.people.reduce((a, p) => a + p.target_status.in_force, 0),
                d.people.reduce((a, p) => a + p.target_status.accepted, 0),
                "",
                "",
            ],
        ],
    };
}

export function teamPerformanceSheets(d: TeamPerformance): ReportSheet[] {
    const f = d.filters;
    const t = d.team;
    const summary: ReportSheet = {
        name: "Summary",
        headers: ["Measure", "Value"],
        rows: [
            ["Period", `${f.from} to ${f.to}`],
            ["Team", TEAM_LABEL[f.team]],
            ["State", f.state ?? "All"],
            ["City", f.city ?? "All"],
            ["Type of business", f.business_type ?? "All"],
            ["Targets month", `${monthLabel(d.target_month)} (${d.working_days.elapsed} of ${d.working_days.total} working days)`],
            ["People", t.people],
            ["Total visits", t.visits],
            ["New dealer visits", t.new_visits],
            ["Dealers visited", t.unique_visits],
            ["Calls", t.calls],
            ["Hot leads (open, today)", t.hot],
            ["Warm leads (open, today)", t.warm],
            ["Cold leads (open, today)", t.cold],
            ["Quotations raised", t.quotes_issued],
            ["Dealers onboarded", t.dealers_onboarded],
            ["Converted", t.converted],
            ["Lost", t.lost],
            ["Lead conversion (converted ÷ closed)", pct(t.conversion_pct)],
            ["KYC submitted", t.kyc_submitted],
            ["Revenue (INR)", t.revenue],
            [],
            ["Team progress against target", ""],
            ...d.team_targets.map((r): Cell[] => [
                `${r.label} (${r.people} ${r.people === 1 ? "person" : "people"})`,
                `${r.actual ?? "not measured"} of ${r.mtd_target} to date · ${r.monthly_target} for the month${r.pct == null ? "" : ` · ${r.pct}%`}`,
            ]),
            [],
            ["Target status", ""],
            ["Accepted", d.target_states.accepted],
            ["Partly accepted", d.target_states.partly_accepted],
            ["Sent, not accepted yet", d.target_states.awaiting_acceptance],
            ["Correction asked", d.target_states.correction_asked],
            ["Posted, not pushed yet", d.target_states.with_sales_head],
            ["No target this month", d.target_states.none],
        ],
    };
    const targets: ReportSheet = {
        name: "Targets",
        headers: ["Person", "Metric", "Status", "Monthly target", "Target to date", "Actual", "% of target to date", "Pushed", "Accepted"],
        rows: d.people.flatMap((p) =>
            p.targets.length === 0
                ? [[p.name ?? p.user_id, "", p.target_status.label, null, null, null, "", "", ""] as Cell[]]
                : p.targets.map((x): Cell[] => [
                      p.name ?? p.user_id,
                      x.label,
                      STATUS_LABEL[x.status] ?? x.status,
                      x.final_target,
                      x.mtd_target,
                      x.actual,
                      pct(x.pct),
                      day(x.pushed_at),
                      day(x.accepted_at),
                  ]),
        ),
    };
    return [summary, peopleSheet(d), targets];
}

export function reportFilename(d: TeamPerformance): string {
    return `team-performance-${d.filters.team}-${d.filters.from}_${d.filters.to}`;
}
