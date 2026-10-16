/**
 * The final monthly target as SQL — ONE definition for every reader (the
 * targets service, the daily digests, the export), so none can disagree.
 *
 *   ID 189 (E-343): the CEO target + the Sales Head's add-only stretch
 *   (stored in admin_addon), e.g. CEO 100 + 50 = 150
 *
 * Both columns hold the version IN FORCE: a CEO revision waits in
 * draft_ceo_target / next_ceo_target and a stretch change on a target the rep
 * already has waits in next_stretch, until the Sales Head pushes it — so a
 * reader never sees a number the rep has not been sent. The E-342
 * sales_head_target (which replaced the CEO's number) is no longer read.
 */
import { sql, type SQL } from "drizzle-orm";

import { visibleStatuses } from "@/lib/targets/rules";

export function finalTargetSql(t: SQL = sql`t`): SQL {
    return sql`(${t}.ceo_target + GREATEST(COALESCE(${t}.admin_addon, 0), 0))`;
}

/**
 * ID 189 — the rows a viewer may see, as SQL (visibleStatuses in ./rules.ts):
 * never a removed row; a CEO draft for the CEO only; for the member, only what
 * was pushed to them. One definition for the service and the export count.
 */
export function targetVisibleSql(viewer: "ceo" | "manager" | "member", t: SQL = sql`t`): SQL {
    return sql`${t}.status IN (${sql.join(visibleStatuses(viewer).map((s) => sql`${s}`), sql`, `)})`;
}
