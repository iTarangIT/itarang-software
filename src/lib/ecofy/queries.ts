// Read side of ecofy_leads for the Ecofy workspace screens (E-305, E-307).

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeads, users } from "@/lib/db/schema";
import { canViewEcofyLead, ecofyViewerKind, ECOFY_ROLE_LABEL } from "./access";
import type { EcofyListCounts, EcofyListParams, EcofyListRow, EcofyListTab } from "./listTypes";

export type EcofyLeadRow = typeof ecofyLeads.$inferSelect;
export type EcofyLeadListRow = EcofyLeadRow & { assignee_name: string | null };

/** Stages that are no longer being worked by iTarang: returned to Ecofy, closed. */
export const ECOFY_DONE_STAGES = ["S0", "CLOSED"] as const;

const openStage = () => or(isNull(ecofyLeads.stage), notInArray(ecofyLeads.stage, [...ECOFY_DONE_STAGES]));

export interface EcofyListFilter {
    /** open = not S0 / CLOSED; queue = S1 and unassigned; all = everything. */
    view?: "open" | "queue" | "all";
    /** The list tabs (E-307 list redesign); takes precedence over `view`. */
    tab?: EcofyListTab;
    stage?: string | null;
    temperature?: string | null;
    segment?: string | null;
    assignee?: string | null; // user id, or "none"
    /** Workers: only their own leads. */
    ownerId?: string | null;
    q?: string | null;
}

/** Everything that narrows the list EXCEPT the tab — shared by rows and counts. */
function commonWhere(f: EcofyListFilter): SQL[] {
    const where: SQL[] = [];
    if (f.stage) where.push(eq(ecofyLeads.stage, f.stage));
    if (f.temperature) where.push(eq(ecofyLeads.temperature, f.temperature.toUpperCase()));
    if (f.segment) where.push(eq(ecofyLeads.segment, f.segment.toUpperCase()));
    if (f.assignee === "none") where.push(isNull(ecofyLeads.assigned_to_user_id));
    else if (f.assignee && /^[0-9a-f-]{36}$/i.test(f.assignee)) where.push(eq(ecofyLeads.assigned_to_user_id, f.assignee));
    if (f.ownerId) where.push(eq(ecofyLeads.assigned_to_user_id, f.ownerId));
    if (f.q && f.q.trim()) {
        const like = `%${f.q.trim()}%`;
        where.push(
            or(
                sql`${ecofyLeads.customer_name} ILIKE ${like}`,
                sql`${ecofyLeads.case_no} ILIKE ${like}`,
                sql`${ecofyLeads.customer_mobile} ILIKE ${like}`,
                sql`${ecofyLeads.city} ILIKE ${like}`,
            )!,
        );
    }
    return where;
}

const followUpDue = () => and(sql`${ecofyLeads.next_follow_up_at} <= now()`, openStage())!;
const meetingToday = () =>
    sql`(${ecofyLeads.next_appointment_at} AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`;
const queueStage = () => and(eq(ecofyLeads.stage, "S1"), isNull(ecofyLeads.assigned_to_user_id))!;
const doneStage = () => inArray(ecofyLeads.stage, [...ECOFY_DONE_STAGES]);

/** The predicate one tab adds on top of `commonWhere` (null = every lead). */
function tabWhere(tab: EcofyListTab): SQL | null {
    switch (tab) {
        case "open":
            return openStage()!;
        case "queue":
            return queueStage();
        case "follow_ups":
            return followUpDue();
        case "meetings_today":
            return meetingToday();
        case "closed":
            return doneStage();
        case "all":
            return null;
    }
}

const listOrder = () => [
    sql`CASE WHEN ${ecofyLeads.temperature} = 'HOT' THEN 0 ELSE 1 END`,
    sql`${ecofyLeads.queue_entered_at} ASC NULLS LAST`,
    asc(ecofyLeads.created_at),
];

/**
 * One page of the list for a tab (E-307 list redesign): rows + the total that
 * matched, so the table can paginate and the CSV can report truncation.
 */
export async function listEcofyLeadsPage(
    f: EcofyListFilter & { tab: EcofyListTab; page: number; limit: number },
): Promise<{ rows: EcofyLeadListRow[]; total: number }> {
    const where = commonWhere(f);
    const t = tabWhere(f.tab);
    if (t) where.push(t);
    const cond = where.length ? and(...where) : undefined;
    const [rows, [{ total }]] = await Promise.all([
        db
            .select({ lead: ecofyLeads, assignee_name: users.name })
            .from(ecofyLeads)
            .leftJoin(users, eq(users.id, ecofyLeads.assigned_to_user_id))
            .where(cond)
            .orderBy(...listOrder())
            .limit(f.limit)
            .offset((f.page - 1) * f.limit),
        db.select({ total: sql<number>`count(*)::int` }).from(ecofyLeads).where(cond),
    ]);
    return { rows: rows.map((r) => ({ ...r.lead, assignee_name: r.assignee_name })), total };
}

/**
 * Per-tab counts for the tab badges. Honour the same search / filters as the
 * rows, so a filtered table never sits under unfiltered numbers.
 */
export async function ecofyTabCounts(f: EcofyListFilter): Promise<EcofyListCounts> {
    const where = commonWhere(f);
    const [row] = await db
        .select({
            open: sql<number>`count(*) FILTER (WHERE ${openStage()})::int`,
            queue: sql<number>`count(*) FILTER (WHERE ${queueStage()})::int`,
            follow_ups: sql<number>`count(*) FILTER (WHERE ${followUpDue()})::int`,
            meetings_today: sql<number>`count(*) FILTER (WHERE ${meetingToday()})::int`,
            closed: sql<number>`count(*) FILTER (WHERE ${doneStage()})::int`,
            all: sql<number>`count(*)::int`,
        })
        .from(ecofyLeads)
        .where(where.length ? and(...where) : undefined);
    return row ?? { open: 0, queue: 0, follow_ups: 0, meetings_today: 0, closed: 0, all: 0 };
}

/**
 * The list filter for a viewer: workers are pinned to their own leads and
 * cannot ask for the pickup queue or another owner; managers may do both.
 * Throws a 403-shaped error for a worker asking for the queue.
 */
export function ecofyListFilterFor(viewer: EcofyViewer, p: EcofyListParams): EcofyListFilter & { tab: EcofyListTab; page: number; limit: number } {
    const kind = ecofyViewerKind(viewer.role);
    if (kind === "worker" && p.tab === "queue") {
        throw new EcofyForbiddenError("The pickup queue is the Sales Head's");
    }
    return {
        tab: p.tab,
        page: p.page,
        limit: p.limit,
        q: p.q ?? null,
        stage: p.stage ?? null,
        temperature: p.temperature ?? null,
        segment: p.segment ?? null,
        assignee: kind === "manager" ? (p.assignee ?? null) : null,
        ownerId: kind === "worker" ? viewer.id : null,
    };
}

export class EcofyForbiddenError extends Error {
    readonly status = 403;
}

/** Server row → list DTO (dates as ISO strings). */
export function toEcofyListRow(l: EcofyLeadListRow): EcofyListRow {
    return {
        id: l.id,
        caseNo: l.case_no,
        customerName: l.customer_name,
        customerMobile: l.customer_mobile,
        city: l.city,
        state: l.state,
        productInterest: l.product_interest,
        segment: l.segment,
        temperature: l.temperature,
        stage: l.stage,
        subStatus: l.sub_status,
        queueEnteredAt: l.queue_entered_at?.toISOString() ?? null,
        assignedTo: l.assigned_to_user_id,
        assigneeName: l.assignee_name ?? null,
        assignedRole: l.assigned_role,
        nextFollowUpAt: l.next_follow_up_at?.toISOString() ?? null,
        nextAppointmentAt: l.next_appointment_at?.toISOString() ?? null,
    };
}

/** Hot first, then the oldest queueEnteredAt (docs/ECOFY_INTEGRATION.md §6, FR-05.1). */
export async function listEcofyLeads(f: EcofyListFilter = {}): Promise<EcofyLeadListRow[]> {
    const where = commonWhere(f);
    const t = f.tab ? tabWhere(f.tab) : f.view === "queue" ? queueStage() : f.view === "all" ? null : openStage()!;
    if (t) where.push(t);

    const rows = await db
        .select({ lead: ecofyLeads, assignee_name: users.name })
        .from(ecofyLeads)
        .leftJoin(users, eq(users.id, ecofyLeads.assigned_to_user_id))
        .where(where.length ? and(...where) : undefined)
        .orderBy(...listOrder())
        .limit(500);
    return rows.map((r) => ({ ...r.lead, assignee_name: r.assignee_name }));
}

export async function getEcofyLead(id: string): Promise<EcofyLeadRow | null> {
    // ids are uuids; anything else cannot match and would make Postgres throw.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await db.select().from(ecofyLeads).where(eq(ecofyLeads.id, id)).limit(1);
    return rows[0] ?? null;
}

export class EcofyNotFoundError extends Error {
    readonly status = 404;
    constructor() {
        super("Lead not found");
    }
}

export interface EcofyViewer {
    id: string;
    name?: string | null;
    role: string;
}

/**
 * The lead, if this viewer may see it. Workers get 404 for anyone else's lead
 * (the lead is invisible to them, not forbidden).
 */
export async function getEcofyLeadForViewer(id: string, viewer: EcofyViewer): Promise<EcofyLeadRow> {
    const lead = await getEcofyLead(id);
    if (!lead || !canViewEcofyLead({ id: viewer.id, role: viewer.role }, lead)) throw new EcofyNotFoundError();
    return lead;
}

/**
 * "Priya Sharma (ASM)" — CRM-INTERNAL only: ecofy_lead_activities.created_by_name,
 * ecofy_sync_events.payload, notifications. It is never sent to Ecofy; the wire
 * always carries the fixed ECOFY_OUTBOUND_ACTOR label (access.ts).
 */
export function ecofyActorName(viewer: EcofyViewer): string {
    const label = ECOFY_ROLE_LABEL[viewer.role.toLowerCase()] ?? viewer.role;
    return `${viewer.name || "CRM user"} (${label})`;
}

/** Counts for the Sales Head dashboard / nav badge, and a worker's own card. */
export async function ecofyCounts(viewer: EcofyViewer) {
    const kind = ecofyViewerKind(viewer.role);
    const own = kind === "worker" ? eq(ecofyLeads.assigned_to_user_id, viewer.id) : undefined;
    const [row] = await db
        .select({
            open: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.stage} IS NULL OR ${ecofyLeads.stage} NOT IN ('S0','CLOSED'))::int`,
            queue: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.stage} = 'S1' AND ${ecofyLeads.assigned_to_user_id} IS NULL)::int`,
            queueHot: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.stage} = 'S1' AND ${ecofyLeads.assigned_to_user_id} IS NULL AND ${ecofyLeads.temperature} = 'HOT')::int`,
            followUpsDue: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.next_follow_up_at} <= now() AND ${ecofyLeads.stage} NOT IN ('S0','CLOSED'))::int`,
            meetingsToday: sql<number>`count(*) FILTER (WHERE (${ecofyLeads.next_appointment_at} AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int`,
        })
        .from(ecofyLeads)
        .where(own);
    return row ?? { open: 0, queue: 0, queueHot: 0, followUpsDue: 0, meetingsToday: 0 };
}

/** Open leads per ASM / ISR, for the Sales Head dashboard. */
export async function ecofyLoadByAssignee() {
    return db
        .select({
            user_id: ecofyLeads.assigned_to_user_id,
            name: users.name,
            role: ecofyLeads.assigned_role,
            open: sql<number>`count(*)::int`,
            hot: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.temperature} = 'HOT')::int`,
            followUpsDue: sql<number>`count(*) FILTER (WHERE ${ecofyLeads.next_follow_up_at} <= now())::int`,
        })
        .from(ecofyLeads)
        .leftJoin(users, eq(users.id, ecofyLeads.assigned_to_user_id))
        .where(and(isNotNull(ecofyLeads.assigned_to_user_id), openStage()))
        .groupBy(ecofyLeads.assigned_to_user_id, users.name, ecofyLeads.assigned_role)
        .orderBy(sql`count(*) DESC`);
}

/** Open leads per stage (local mirror), for the dashboard funnel. */
export async function ecofyStageCounts() {
    return db
        .select({ stage: ecofyLeads.stage, n: sql<number>`count(*)::int` })
        .from(ecofyLeads)
        .groupBy(ecofyLeads.stage);
}

/** CRM lead ids for Ecofy case ids (queues list Ecofy cases). */
export async function crmLeadIdsForCases(caseIds: string[]): Promise<Map<string, string>> {
    if (caseIds.length === 0) return new Map();
    const rows = await db
        .select({ id: ecofyLeads.id, case_id: ecofyLeads.ecofy_case_id })
        .from(ecofyLeads)
        .where(inArray(ecofyLeads.ecofy_case_id, caseIds));
    return new Map(rows.map((r) => [r.case_id, r.id]));
}

/** Only ever link out to an https URL — ecofyUrl arrives from another system. */
export function safeEcofyUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === "https:" ? u.toString() : null;
    } catch {
        return null;
    }
}
