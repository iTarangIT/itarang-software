// my_leads_by_temperature — the leads behind the Hot / Warm / Cold cards on the
// user's performance page ("Hot 9 open leads"), with phone and ageing.
//
// The population and the ageing are the dashboard's own SQL fragments
// (OPEN_RATED_LEAD, interestAgeSql from buildSalesDashboard's Section D),
// pinned to the caller as owner exactly as my_numbers pins spoc_id — so `total`
// here is the card's number by construction, never a count the model makes.
// Rows and total come from ONE statement (count(*) OVER ()), so a write between
// two queries can't make them disagree.
//
// Not a queue tab: an ASM's My Active Visits leaves out Number-Repair leads,
// the card does not. Owner = the user, so this stays inside ID 45's own scope.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { OPEN_RATED_LEAD, interestAgeSql } from "@/lib/admin/salesDashboard";
import { MAX_TOOL_ROWS, type AssistantUser, type ToolResult } from "../../types";
import { istNow } from "../../prompt";
import { defineTool, type ToolFactory } from "../spec";
import { scopeJoin } from "../../scope";
import { performanceUrl, toLeadSummary } from "../leads";
import { METRIC_DEFINITIONS } from "./myNumbers";

export const TEMPERATURES = ["hot", "warm", "cold"] as const;
export type Temperature = (typeof TEMPERATURES)[number];

const LABEL: Record<Temperature, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };

type Row = {
    id: string;
    shop_name: string | null;
    dealer_name: string | null;
    phone: string | null;
    city: string | null;
    lead_status: string | null;
    interest_level: string | null;
    current_owner_id: string | null;
    last_touchpoint_at: unknown;
    next_date: unknown;
    visit_status: string | null;
    age_days: number;
    total: number;
};

/** The exact query — exported so the verify script checks totals against the dashboard. */
export async function temperatureRowsForTool(user: AssistantUser, level: Temperature, today: string) {
    // What the user acts on next: an ASM's latest visit date (kept by
    // toLeadSummary only while that visit is still open), an ISR's follow-up.
    const nextCols =
        user.role === "asm"
            ? sql`lv.scheduled_date::text AS next_date, lv.visit_status`
            : sql`dl.next_follow_up_at AS next_date, NULL::text AS visit_status`;
    const rows = await db.execute<Row>(sql`
        SELECT dl.id, dl.shop_name, dl.dealer_name, dl.phone, dl.city, dl.lead_status, dl.interest_level,
               dl.current_owner_id, dl.last_touchpoint_at,
               ${nextCols},
               ${interestAgeSql(today)}::int AS age_days,
               count(*) OVER ()::int AS total
          FROM dealer_leads dl
          ${scopeJoin(user)}
         WHERE ${OPEN_RATED_LEAD}
           AND dl.current_owner_id = ${user.id}
           AND lower(dl.interest_level) = ${level}
         ORDER BY age_days DESC, COALESCE(dl.shop_name, dl.dealer_name) ASC, dl.id ASC
         LIMIT ${MAX_TOOL_ROWS}
    `);
    const list = rows as unknown as Row[];
    return { rows: list, total: list[0]?.total ?? 0 };
}

export const myLeadsByTemperature: ToolFactory = () =>
    defineTool({
        name: "my_leads_by_temperature",
        kind: "read",
        description:
            "The user's own open Hot, Warm or Cold leads — exactly the leads behind the Hot / Warm / Cold numbers on " +
            "their performance page (and in my_numbers). Each lead with phone, status, how many days it has been at " +
            "this temperature, and last activity; `total` is the exact count. Use it for any question about hot / " +
            "warm / cold leads: how many, which ones, names, numbers, ageing.",
        schema: z.object({
            interest: z.enum(TEMPERATURES).describe("hot, warm or cold"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const level = input.interest as Temperature;
            const { rows, total } = await temperatureRowsForTool(ctx.user, level, istNow(ctx.now).isoDate);
            return {
                kind: "lead_report",
                title: `${LABEL[level]} leads`,
                definition: `${METRIC_DEFINITIONS.interest}; age = days since it became ${LABEL[level]}`,
                rows: rows.map((r) => ({
                    ...toLeadSummary(
                        ctx.user.role === "asm"
                            ? { ...r, scheduled_date: r.next_date }
                            : { ...r, next_follow_up_at: r.next_date },
                        ctx.user,
                    ),
                    age_days: Number(r.age_days),
                })),
                total,
                crm_url: performanceUrl(ctx.user),
            };
        },
    });

