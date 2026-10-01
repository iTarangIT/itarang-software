// my_numbers — "how am I doing" (BRD §9.1, UC-09). The performance page's own
// builders, pinned to the caller, never restated:
//   • buildSalesDashboard({ spoc_id: user.id, … }) — as /api/{inside-sales,asm}/
//     reports/sales-dashboard call it — for activity and hot/warm/cold;
//   • listTargets({ month, userId }) — as /api/me/targets does — for each target
//     with its pro-rated MTD value and RAG; only pushed/accepted rows, which is
//     what MyTargetsCard shows.
// Period is month-to-date (UC-09), not the dashboard screen's default 30 days.
// The reply states the definition behind every figure.

import { z } from "zod";
import { buildSalesDashboard, type SalesDashboard } from "@/lib/admin/salesDashboard";
import { listTargets, type TargetRow } from "@/lib/targets/service";
import { monthEnd } from "@/lib/targets/rules";
import type { AssistantUser, ToolResult } from "../../types";
import { istNow } from "../../prompt";
import { defineTool, type ToolFactory } from "../spec";
import { performanceUrl } from "../leads";

/** What each figure means — stated in the reply (UC-09 "stating the definition used"). */
export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
    visits: "lead visits you logged with a visit date in the period",
    unique_visits: "distinct dealers you visited",
    new_visits: "dealers visited for the first time ever",
    calls: "calls you made: inside-sales calls plus AI-dialer calls on your leads",
    converted: "leads that closed as Converted while you held them",
    interest: "open leads you own, by current temperature",
    calls_per_day: "your logged inside-sales calls (AI-dialer calls NOT counted) per working day so far",
    hot_to_ground: "leads you transferred to an ASM that are hot now",
    dealer_visits: "visits you logged this month, new and existing dealers",
    new_dealer_visits: "dealers visited for the first time ever",
    batteries_sold: "batteries to dealers this month",
    kyc_submitted: "KYC files submitted this month",
    kyc_disbursed: "not measured in the CRM yet",
    scrap_deals: "buyback deals the dealer accepted",
    revenue: "revenue this month (₹)",
    target: "monthly target pro-rated over working days (Mon–Sat, minus holidays); RAG: green ≥100%, amber 80–99%, red <80%",
});

export type NumbersPeriod = "this_month" | "last_month";

/** The exact builder calls — exported so the Gate 3 equality check reuses them. */
export function numbersInputs(user: AssistantUser, period: NumbersPeriod, now: Date) {
    const today = istNow(now).isoDate;
    const thisMonth = `${today.slice(0, 7)}-01`;
    let from = thisMonth;
    let to = today;
    if (period === "last_month") {
        const d = new Date(`${thisMonth}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() - 1);
        from = d.toISOString().slice(0, 10);
        to = monthEnd(from);
    }
    const dashboardInput = {
        from,
        to,
        city: null,
        state: null,
        spoc_id: user.id,
        business_type: null,
        granularity: "day" as const,
    };
    return { from, to, month: from.slice(0, 7), dashboardInput };
}

export function shapeNumbers(
    user: AssistantUser,
    period: NumbersPeriod,
    range: { from: string; to: string },
    dashboard: SalesDashboard,
    targets: TargetRow[],
): Record<string, unknown> {
    const shown = targets.filter((t) => t.status === "pushed" || t.status === "accepted");
    const interest = Object.fromEntries(dashboard.interest.rows.map((r) => [r.interest_level, r.total]));
    return {
        period,
        from: range.from,
        to: range.to,
        as_of: dashboard.as_of_date,
        activity: {
            visits: dashboard.totals.visits,
            unique_visits: dashboard.totals.unique_visits,
            new_visits: dashboard.totals.new_visits,
            calls: dashboard.totals.calls,
            converted: dashboard.totals.converted,
        },
        ...(user.role === "asm"
            ? {
                  planned_visits: {
                      today: dashboard.snapshot.planned_visits_today,
                      next_7_days: dashboard.snapshot.planned_visits_next_7_days,
                  },
              }
            : {}),
        interest,
        targets: shown.map((t) => ({
            metric: t.metric,
            label: t.metric_label,
            monthly_target: t.progress.monthly_target,
            mtd_target: t.progress.mtd_target,
            actual: t.progress.actual,
            pct_of_mtd: t.progress.pct_of_mtd,
            rag: t.progress.rag,
            definition: METRIC_DEFINITIONS[t.metric] ?? null,
        })),
        targets_note:
            shown.length === 0
                ? "No targets have been pushed to you for this month."
                : METRIC_DEFINITIONS.target,
        definitions: {
            visits: METRIC_DEFINITIONS.visits,
            calls: METRIC_DEFINITIONS.calls,
            converted: METRIC_DEFINITIONS.converted,
            interest: METRIC_DEFINITIONS.interest,
        },
        crm_url: performanceUrl(user),
    };
}

export const myNumbers: ToolFactory = () =>
    defineTool({
        name: "my_numbers",
        kind: "read",
        description:
            "The user's own numbers for a month: activity (visits, calls, conversions), hot/warm/cold leads, and each " +
            "target with its pro-rated month-to-date value and RAG. Always say which definition a figure uses.",
        schema: z.object({
            period: z.enum(["this_month", "last_month"]).default("this_month"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const period = input.period as NumbersPeriod;
            const { from, to, month, dashboardInput } = numbersInputs(ctx.user, period, ctx.now);
            const [dashboard, targets] = await Promise.all([
                buildSalesDashboard(dashboardInput),
                listTargets({ month, userId: ctx.user.id }),
            ]);
            return { kind: "numbers", data: shapeNumbers(ctx.user, period, { from, to }, dashboard, targets) };
        },
    });
