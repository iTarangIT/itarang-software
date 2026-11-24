// 24 Nov (CRM items 5 + 7) — the manager's Team pages. Server only.
//
//   Team leads   every lead a team member owns, with its latest action (any
//                touchpoint) and its latest comment (the newest touchpoint with
//                remarks), newest action first.
//   Team visits  lead_visits rows, in two SEPARATE lists that never mix:
//                  scheduled — visits planned FOR a day in the range
//                              (scheduled_date), whatever happened to them since;
//                  completed — visits actually DONE on a day in the range
//                              (visit_status 'visited', actual_visit_date).
//
// Scope: the oversight roles (LEADS_OVERSIGHT_ROLES) see everyone; anyone else
// sees themself + their direct reports (getTeamMemberIds, ID 155). A `member`
// outside that scope is ignored, never an error that confirms the id exists.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { LEADS_OVERSIGHT_ROLES } from "@/lib/leads/access";
import { getTeamMemberIds } from "@/lib/users/team";
import { ownerScopeIds } from "@/lib/users/teamRules";
import { businessTypeFilterParam, BUSINESS_TYPE_UNSET } from "@/lib/leads/businessType";
import { resolveTeamFilters, type TeamFilters, type TeamScope, type VisitKind } from "./teamFilters";

export type { TeamFilters, VisitKind } from "./teamFilters";

export const TEAM_LIST_LIMIT = 500;
export const TEAM_EXPORT_LIMIT = 10_000;

export async function teamScopeFor(user: { id: string; role: string | null | undefined }): Promise<TeamScope> {
    const all = (LEADS_OVERSIGHT_ROLES as readonly string[]).includes(user.role ?? "");
    if (all) {
        // Everyone who owns a live lead or has a visit — the member picker.
        const people = (await db.execute(sql`
            SELECT u.id::text AS id, COALESCE(NULLIF(u.name, ''), u.email) AS name
              FROM users u
             WHERE u.id::text IN (
                   SELECT current_owner_id FROM dealer_leads
                    WHERE current_owner_id IS NOT NULL AND is_active IS NOT FALSE AND deleted_at IS NULL
                   UNION
                   SELECT asm_id FROM lead_visits)
             ORDER BY 2
        `)) as unknown as Array<{ id: string; name: string }>;
        return { all: true, ownerIds: people.map((p) => p.id), people };
    }
    const ids = ownerScopeIds(user.id, await getTeamMemberIds(user.id));
    const people = (await db.execute(sql`
        SELECT id::text AS id, COALESCE(NULLIF(name, ''), email) AS name FROM users
         WHERE id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         ORDER BY 2
    `)) as unknown as Array<{ id: string; name: string }>;
    return { all: false, ownerIds: ids, people };
}

const inList = (col: SQL, ids: readonly string[]) =>
    ids.length ? sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`FALSE`;

/** WHERE parts shared by both pages for the lead's own columns. */
function leadConds(f: TeamFilters): SQL[] {
    const c: SQL[] = [sql`dl.is_active IS NOT FALSE`, sql`dl.deleted_at IS NULL`];
    if (f.city) c.push(sql`lower(trim(dl.city)) = lower(trim(${f.city}))`);
    const bt = businessTypeFilterParam(f.businessType);
    if (bt === BUSINESS_TYPE_UNSET) c.push(sql`(to_jsonb(dl) ->> 'business_type') IS NULL`);
    else if (bt) c.push(sql`(to_jsonb(dl) ->> 'business_type') = ${bt}`);
    return c;
}

export type TeamLeadRow = {
    id: string;
    name: string;
    city: string | null;
    business_type: string | null;
    lead_status: string | null;
    interest_level: string | null;
    owner_id: string | null;
    owner_name: string | null;
    last_action_type: string | null;
    last_action_at: string | null;
    last_action_by: string | null;
    last_comment: string | null;
    last_comment_at: string | null;
    last_comment_by: string | null;
    next_follow_up_at: string | null;
};

export async function listTeamLeads(
    scope: TeamScope,
    raw: Partial<TeamFilters>,
    limit = TEAM_LIST_LIMIT,
): Promise<{ rows: TeamLeadRow[]; truncated: boolean }> {
    const f = resolveTeamFilters(scope, raw);
    const owners = f.member ? [f.member] : scope.ownerIds;
    const conds = [...leadConds(f), inList(sql`dl.current_owner_id`, owners)];
    if (f.status) conds.push(sql`dl.lead_status = ${f.status}`);
    if (f.q) {
        const like = `%${f.q}%`;
        conds.push(sql`(dl.dealer_name ILIKE ${like} OR dl.shop_name ILIKE ${like} OR dl.phone ILIKE ${like} OR dl.id ILIKE ${like})`);
    }
    // The date range is on the latest action (IST days).
    if (f.from) conds.push(sql`(la.performed_at AT TIME ZONE 'Asia/Kolkata')::date >= ${f.from}::date`);
    if (f.to) conds.push(sql`(la.performed_at AT TIME ZONE 'Asia/Kolkata')::date <= ${f.to}::date`);

    const rows = (await db.execute(sql`
        SELECT dl.id,
               COALESCE(NULLIF(dl.shop_name, ''), NULLIF(dl.dealer_name, ''), dl.id) AS name,
               dl.city,
               to_jsonb(dl) ->> 'business_type' AS business_type,
               dl.lead_status,
               dl.interest_level,
               dl.current_owner_id AS owner_id,
               COALESCE(NULLIF(ou.name, ''), ou.email) AS owner_name,
               la.touchpoint_type AS last_action_type,
               to_json(la.performed_at) #>> '{}' AS last_action_at,
               COALESCE(NULLIF(lau.name, ''), lau.email, la.external_agent_name) AS last_action_by,
               lc.remarks AS last_comment,
               to_json(lc.performed_at) #>> '{}' AS last_comment_at,
               COALESCE(NULLIF(lcu.name, ''), lcu.email, lc.external_agent_name) AS last_comment_by,
               to_json(dl.next_follow_up_at) #>> '{}' AS next_follow_up_at
          FROM dealer_leads dl
          LEFT JOIN users ou ON ou.id::text = dl.current_owner_id
          LEFT JOIN LATERAL (
                SELECT t.touchpoint_type, t.performed_at, t.performed_by, t.external_agent_name
                  FROM lead_touchpoints t
                 WHERE t.dealer_lead_id = dl.id
                 ORDER BY t.performed_at DESC
                 LIMIT 1) la ON TRUE
          LEFT JOIN users lau ON lau.id::text = la.performed_by
          LEFT JOIN LATERAL (
                SELECT t.remarks, t.performed_at, t.performed_by, t.external_agent_name
                  FROM lead_touchpoints t
                 WHERE t.dealer_lead_id = dl.id
                   AND NULLIF(btrim(t.remarks), '') IS NOT NULL
                 ORDER BY t.performed_at DESC
                 LIMIT 1) lc ON TRUE
          LEFT JOIN users lcu ON lcu.id::text = lc.performed_by
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY la.performed_at DESC NULLS LAST, dl.id
         LIMIT ${limit + 1}
    `)) as unknown as TeamLeadRow[];
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export type TeamVisitRow = {
    visit_id: string;
    lead_id: string;
    lead_name: string;
    city: string | null;
    business_type: string | null;
    rep_id: string;
    rep_name: string | null;
    scheduled_date: string | null;
    actual_visit_date: string | null;
    visit_status: string;
    visit_outcome: string | null;
    visit_remarks: string | null;
    next_visit_date: string | null;
    verified: boolean;
};

export async function listTeamVisits(
    scope: TeamScope,
    kind: VisitKind,
    raw: Partial<TeamFilters>,
    limit = TEAM_LIST_LIMIT,
): Promise<{ rows: TeamVisitRow[]; truncated: boolean; from: string; to: string }> {
    const f = resolveTeamFilters(scope, raw, { defaultRange: true });
    const reps = f.member ? [f.member] : scope.ownerIds;
    const day = kind === "completed" ? sql`lv.actual_visit_date` : sql`lv.scheduled_date`;
    const conds = [...leadConds(f), inList(sql`lv.asm_id`, reps), sql`${day} >= ${f.from}::date`, sql`${day} <= ${f.to}::date`];
    if (kind === "completed") conds.push(sql`lv.visit_status = 'visited'`);
    else conds.push(sql`lv.scheduled_date IS NOT NULL`);

    const rows = (await db.execute(sql`
        SELECT lv.visit_id::text AS visit_id,
               dl.id AS lead_id,
               COALESCE(NULLIF(dl.shop_name, ''), NULLIF(dl.dealer_name, ''), dl.id) AS lead_name,
               dl.city,
               to_jsonb(dl) ->> 'business_type' AS business_type,
               lv.asm_id AS rep_id,
               COALESCE(NULLIF(u.name, ''), u.email) AS rep_name,
               lv.scheduled_date::text AS scheduled_date,
               lv.actual_visit_date::text AS actual_visit_date,
               lv.visit_status,
               lv.visit_outcome,
               lv.visit_remarks,
               lv.next_visit_date::text AS next_visit_date,
               COALESCE((to_jsonb(lv) ->> 'verified')::boolean, FALSE) AS verified
          FROM lead_visits lv
          JOIN dealer_leads dl ON dl.id = lv.dealer_lead_id
          LEFT JOIN users u ON u.id::text = lv.asm_id
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY ${day} DESC, lv.created_at DESC
         LIMIT ${limit + 1}
    `)) as unknown as TeamVisitRow[];
    return { rows: rows.slice(0, limit), truncated: rows.length > limit, from: f.from!, to: f.to! };
}
