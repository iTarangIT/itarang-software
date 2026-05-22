// GET /api/admin/settings — the admin settings bundle (BRD §0.11/§0.12):
// assignment config (singleton), holiday calendar, ASM territories.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type {
    AssignmentConfig,
    HolidayRow,
    SettingsBundle,
    TerritoryRow,
} from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const DEFAULT_WORKING_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat"];

export const GET = withErrorHandler(async () => {
    await requireRole(["admin", "sales_head"]);

    const cfgRows = await db.execute<{
        config_id: string;
        intent_score_threshold: number | null;
        working_hours_start: string | null;
        working_hours_end: string | null;
        working_days: unknown;
        updated_by: string | null;
        updated_by_name: string | null;
        updated_at: string | null;
    }>(sql`
        SELECT ac.config_id, ac.intent_score_threshold, ac.working_hours_start,
               ac.working_hours_end, ac.working_days, ac.updated_by,
               u.name AS updated_by_name, ac.updated_at
        FROM assignment_config ac
        LEFT JOIN users u ON u.id::text = ac.updated_by
        ORDER BY ac.created_at ASC
        LIMIT 1
    `);
    const cfg = cfgRows[0];
    const assignment_config: AssignmentConfig = cfg
        ? {
              config_id: cfg.config_id,
              intent_score_threshold: Number(cfg.intent_score_threshold ?? 60),
              working_hours_start: cfg.working_hours_start ?? "09:00",
              working_hours_end: cfg.working_hours_end ?? "19:00",
              working_days: Array.isArray(cfg.working_days)
                  ? (cfg.working_days as string[])
                  : DEFAULT_WORKING_DAYS,
              updated_by: cfg.updated_by ?? null,
              updated_by_name: cfg.updated_by_name ?? null,
              updated_at: cfg.updated_at ?? null,
          }
        : {
              config_id: null,
              intent_score_threshold: 60,
              working_hours_start: "09:00",
              working_hours_end: "19:00",
              working_days: DEFAULT_WORKING_DAYS,
              updated_by: null,
              updated_by_name: null,
              updated_at: null,
          };

    const holidays = await db.execute<HolidayRow>(sql`
        SELECT holiday_id, holiday_date::text AS holiday_date,
               holiday_name, is_active
        FROM holiday_calendar
        ORDER BY holiday_date DESC
    `);

    const territories = await db.execute<TerritoryRow>(sql`
        SELECT t.territory_id, t.asm_id, u.name AS asm_name, t.state, t.city,
               t.active_from::text AS active_from, t.active_to::text AS active_to
        FROM asm_territories t
        LEFT JOIN users u ON u.id::text = t.asm_id
        ORDER BY t.state ASC, t.city ASC NULLS FIRST
    `);

    const bundle: SettingsBundle = {
        assignment_config,
        holidays: holidays as unknown as HolidayRow[],
        territories: territories as unknown as TerritoryRow[],
    };
    return successResponse(bundle);
});
