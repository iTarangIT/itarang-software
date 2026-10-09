// City / state / type-of-business on a dealer_leads alias — the ONE predicate
// every Sales Head number uses (ID 11), so the dashboard tiles and the reports
// beside them filter the same leads.
//
// City and state compare trimmed and case-folded, so "nashik" and "Nashik" are
// one place; an unknown value simply matches nothing (read as zeros).
// business_type is emitted ONLY when asked for: the column is outside schema.ts
// (E-296), and naming it unconditionally would fail on a host that lacks it.
// "unset" matches leads with no type yet.

import { sql, type SQL } from "drizzle-orm";

import { BUSINESS_TYPE_UNSET, isBusinessTypeFilter } from "./businessType";

export type LeadScopeFilters = {
    city?: string | null;
    state?: string | null;
    business_type?: string | null;
};

/** `AND …` fragments for the filters that are set; empty SQL when none are. */
export function leadScopeSql(f: LeadScopeFilters, dl: SQL = sql`dl`): SQL {
    const parts: SQL[] = [];
    if (f.city) parts.push(sql` AND lower(trim(${dl}.city)) = lower(trim(${f.city}))`);
    if (f.state) parts.push(sql` AND lower(trim(${dl}.state)) = lower(trim(${f.state}))`);
    if (f.business_type && isBusinessTypeFilter(f.business_type)) {
        parts.push(
            f.business_type === BUSINESS_TYPE_UNSET
                ? sql` AND ${dl}.business_type IS NULL`
                : sql` AND ${dl}.business_type = ${f.business_type}`,
        );
    }
    return parts.length ? sql.join(parts, sql``) : sql``;
}

/** True when any lead-scope filter is set (a query may skip a join otherwise). */
export const hasLeadScope = (f: LeadScopeFilters): boolean =>
    Boolean(f.city || f.state || (f.business_type && isBusinessTypeFilter(f.business_type)));
