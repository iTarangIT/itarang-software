/**
 * Tracker ID 155 — a manager's team, read from the database. Server only.
 *
 * Team = DIRECT reports on the current, open reporting line: the open
 * user_reporting_lines row (E-338), or users.reports_to (E-335) on a database
 * without the history table. Both read "no team" on a database with neither,
 * so nobody's access widens by accident. Pure rules: ./teamRules.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasReportingHistoryTable, hasReportsToColumn } from "./reportingLines";
import { exportsOwnLeadsOnly } from "@/lib/leads/access";
import { ownerScopeIds } from "./teamRules";

/** Direct reports of `managerId` on their current line (empty = not a manager). */
export async function getTeamMemberIds(managerId: string | null | undefined): Promise<string[]> {
    if (!managerId) return [];
    try {
        if (await hasReportingHistoryTable()) {
            const rows = (await db.execute(sql`
                SELECT l.user_id::text AS id
                FROM user_reporting_lines l
                WHERE l.manager_id::text = ${managerId}
                  AND l.effective_to IS NULL
                  AND l.effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
            `)) as unknown as Array<{ id: string }>;
            return rows.map((r) => r.id);
        }
        if (await hasReportsToColumn()) {
            const rows = (await db.execute(sql`
                SELECT u.id::text AS id FROM users u WHERE to_jsonb(u) ->> 'reports_to' = ${managerId}
            `)) as unknown as Array<{ id: string }>;
            return rows.map((r) => r.id);
        }
    } catch (err) {
        // Access must never fail open: an error reads as "no team".
        console.warn("[team] getTeamMemberIds failed; treating as no team", err);
    }
    return [];
}

/**
 * ID 155/156: the manager's direct reports with names, for a person picker
 * (by name). Empty for anyone without a team.
 */
export async function getTeamPeople(managerId: string): Promise<Array<{ id: string; name: string }>> {
    const ids = await getTeamMemberIds(managerId);
    if (ids.length === 0) return [];
    const rows = (await db.execute(sql`
        SELECT id::text AS id, COALESCE(name, email) AS name FROM users
        WHERE id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        ORDER BY name ASC
    `)) as unknown as Array<{ id: string; name: string }>;
    return rows;
}

/**
 * ID 155: may `userId` READ lead `leadId` under the own-leads rule (ID 45)?
 * True when they own it, or a direct report of theirs owns it. Read paths
 * only; changing a lead stays with its owner (assertOwner).
 */
export async function leadVisibleTo(leadId: string, userId: string): Promise<boolean> {
    const owners = ownerScopeIds(userId, await getTeamMemberIds(userId));
    const rows = (await db.execute(sql`
        SELECT TRUE AS ok FROM dealer_leads
        WHERE id = ${leadId}
          AND current_owner_id IN (${sql.join(owners.map((o) => sql`${o}`), sql`, `)})
        LIMIT 1
    `)) as unknown as Array<{ ok: boolean }>;
    return rows.length > 0;
}

/**
 * ID 155: the viewer's direct reports, for widening a queue / list the way the
 * /leads list was widened. Looked up only for the own-scoped roles
 * (exportsOwnLeadsOnly: asm, inside_sales_rep, partner) — every other role
 * already sees more than its own leads. Empty for anyone without a team, so
 * their queries stay exactly as before.
 */
export async function teamForOwnScopedViewer(user: { id: string; role: string | null | undefined }): Promise<string[]> {
    return exportsOwnLeadsOnly(user.role) ? getTeamMemberIds(user.id) : [];
}
