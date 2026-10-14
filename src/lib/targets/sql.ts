/**
 * The final monthly target as SQL — ONE definition for every reader (the
 * targets service, the daily digests, the export), so none can disagree.
 *
 *   the Sales Head's number when they entered one (> 0), else the CEO's
 *   (plus any legacy admin add-on)
 *
 * sales_head_target (E-341) is read through to_jsonb so a DB without the column
 * falls back to the CEO target instead of failing the statement.
 */
import { sql, type SQL } from "drizzle-orm";

export function finalTargetSql(t: SQL = sql`t`): SQL {
    return sql`COALESCE(NULLIF((to_jsonb(${t}) ->> 'sales_head_target')::numeric, 0), ${t}.ceo_target + ${t}.admin_addon)`;
}
