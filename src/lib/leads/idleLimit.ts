/**
 * "Idle past limit" (tracker ID 192) — the ONE SQL rule for a lead whose
 * holder has let it sit past their idle limit, shared by the Leads list
 * filter, the exports and the ISR queue (so the three cannot disagree with
 * Needs Attention, whose threshold this is):
 *
 *   working days since FOLLOW_UP_AGEING_BASIS (followUpAgeing.ts; the office
 *   calendar's working days, holidays off — workingDaysSinceSql)
 *     >= idle_asm   when the holder is an ASM
 *     >= idle_cc    otherwise (inside sales and everyone else)
 *
 * The limits are ID 85 time limits read IN SQL for today's IST date
 * (limitOnDaySql), so a dated change applies from its day with no redeploy.
 * Server only (the working-day SQL reads holiday_calendar).
 */
import { sql, type SQL } from "drizzle-orm";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";
import { FOLLOW_UP_AGEING_BASIS } from "@/lib/leads/followUpAgeing";
import { hasTimeLimitTable, limitOnDaySql } from "@/lib/timeLimits/store";

const IST_TODAY = sql`(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Working days the holder has let the lead (alias `dl`) sit — the Idle number. An int. */
export const IDLE_WORKING_DAYS_SQL: SQL = workingDaysSinceSql(FOLLOW_UP_AGEING_BASIS);

/** The holder's role over the alias `dl` (lower-cased; NULL without an owner). */
export const OWNER_ROLE_SQL: SQL = sql`(SELECT lower(u.role) FROM users u WHERE u.id::text = dl.current_owner_id)`;

/**
 * The idle limit (working days) for a holder role — idle_asm for 'asm',
 * idle_cc otherwise. `role` is a lower-cased role expression; `withTable` is
 * hasTimeLimitTable() (false = the registry defaults as literals).
 */
export function idleLimitForRoleSql(role: SQL, withTable: boolean, day: SQL = IST_TODAY): SQL {
    return sql`(CASE WHEN (${role}) = 'asm' THEN ${limitOnDaySql("idle_asm", day, withTable)}
                     ELSE ${limitOnDaySql("idle_cc", day, withTable)} END)`;
}

/**
 * SQL boolean over the alias `dl`: the lead is idle at or past its holder's
 * idle limit. Leads without an owner are never "past limit" (nobody holds
 * them — that is the Ready-to-assign list). Pass `role` when the query
 * already joins the holder (e.g. `lower(u.role)`); by default the role is
 * looked up from dl.current_owner_id.
 *
 *     const withTable = await hasTimeLimitTable();
 *     conds.push(idlePastLimitSql({ withTable }));
 */
export function idlePastLimitSql(opts: { withTable: boolean; role?: SQL; idleDays?: SQL }): SQL {
    const role = opts.role ?? OWNER_ROLE_SQL;
    const days = opts.idleDays ?? IDLE_WORKING_DAYS_SQL;
    return sql`(dl.current_owner_id IS NOT NULL AND ${days} >= ${idleLimitForRoleSql(role, opts.withTable)})`;
}

/** idlePastLimitSql with the time-limit table probe done. */
export async function idlePastLimit(opts: { role?: SQL; idleDays?: SQL } = {}): Promise<SQL> {
    return idlePastLimitSql({ ...opts, withTable: await hasTimeLimitTable() });
}
