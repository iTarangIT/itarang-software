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
import { monthEnd, TARGET_METRICS, type TargetMetric } from "@/lib/targets/rules";
import type { AssistantUser, ToolResult } from "../../types";
import { istNow } from "../../prompt";
import { defineTool, type ToolFactory } from "../spec";
import { performanceUrl } from "../leads";

/**
 * What each figure means — stated in the reply (UC-09 "stating the definition
 * used"). Worded for ANY period (the reply says which one), and each matches
 * what buildSalesDashboard / the targets service actually count.
 */
export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
    visits: "visits you completed (an actual visit date logged), counted on the actual visit date — one per dealer per day",
    unique_visits: "distinct dealers you visited in the period (a dealer visited twice counts once)",
    new_visits: "dealers whose first-ever visit was in the period",
    planned_visits: "your open visits (not visited, cancelled or no-show) scheduled for today / the next 7 days — as of now",
    calls: "calls you made yourself in the period (AI-dialer calls NOT counted); a NeoDove call re-dispositioned within 3 minutes counts once",
    converted: "leads closed as Converted in the period while you held them",
    interest: "open leads you own today, by current temperature — a snapshot as of now, the same for any period",
    calls_per_day: "your logged inside-sales calls (AI-dialer calls NOT counted) per working day so far — a DAILY target",
    hot_to_ground: "leads you transferred to an ASM that were Hot at the moment of transfer",
    dealer_visits: "distinct dealers you visited in the month, new and existing (two visits to one dealer count once)",
    new_dealer_visits: "dealers visited for the first time ever, in the month",
    batteries_sold: "batteries to dealers in the month",
    kyc_submitted: "KYC files submitted in the month",
    kyc_disbursed: "not measured in the CRM yet",
    scrap_deals: "buyback deals the dealer accepted",
    revenue: "revenue in the month (₹)",
    target: "monthly target pro-rated over working days (Mon–Sat, minus holidays); a per-day target (e.g. calls per day) is the same every day, not pro-rated; RAG: green ≥100%, amber 80–99%, red <80%",
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
        targets: shown.map((t) =>
            // A per-day target (calls_per_day) is a DAILY number — progress()
            // keeps it un-pro-rated, so it must not be read out as a monthly one.
            TARGET_METRICS[t.metric as TargetMetric]?.kind === "per_day"
                ? {
                      metric: t.metric,
                      label: t.metric_label,
                      daily_target: t.progress.monthly_target,
                      actual_per_day: t.progress.actual,
                      pct_of_target: t.progress.pct_of_mtd,
                      rag: t.progress.rag,
                      definition: METRIC_DEFINITIONS[t.metric] ?? null,
                  }
                : {
                      metric: t.metric,
                      label: t.metric_label,
                      monthly_target: t.progress.monthly_target,
                      mtd_target: t.progress.mtd_target,
                      actual: t.progress.actual,
                      pct_of_mtd: t.progress.pct_of_mtd,
                      rag: t.progress.rag,
                      definition: METRIC_DEFINITIONS[t.metric] ?? null,
                  },
        ),
        targets_note:
            shown.length === 0
                ? "No targets have been pushed to you for this month."
                : METRIC_DEFINITIONS.target,
        // Last month's activity is last month's; these two are today's.
        ...(period === "last_month"
            ? {
                  as_of_now_note:
                      user.role === "asm"
                          ? "interest and planned_visits are as of now, not as of last month"
                          : "interest is as of now, not as of last month",
              }
            : {}),
        // One definition for every figure returned above.
        definitions: {
            visits: METRIC_DEFINITIONS.visits,
            unique_visits: METRIC_DEFINITIONS.unique_visits,
            new_visits: METRIC_DEFINITIONS.new_visits,
            calls: METRIC_DEFINITIONS.calls,
            converted: METRIC_DEFINITIONS.converted,
            interest: METRIC_DEFINITIONS.interest,
            ...(user.role === "asm" ? { planned_visits: METRIC_DEFINITIONS.planned_visits } : {}),
        },
        // The performance page reads ?from=&to= (useSalesDashboardFilters), so
        // the link opens on the same range these figures cover.
        crm_url: `${performanceUrl(user)}?from=${range.from}&to=${range.to}`,
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
