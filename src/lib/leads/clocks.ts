/**
 * Lead clocks (tracker ID 86) — load, compute, store, read.
 *
 * refreshLeadClocks() rebuilds lead_clocks (E-337) for EVERY lead from the
 * source rows, so the first run is the back-fill and every later run picks up
 * new calls, visits, assignments and limit changes. Run hourly by the
 * lead-clocks ticker (instrumentation-node.ts) and by
 * scripts/refresh-lead-clocks.ts. The rules are in clockRules.ts.
 *
 * Readers (the daily email, dashboards, downloads, the event log) read the
 * table; without E-337 they report "not measured" instead of failing.
 *
 * `db` (and the modules that hold it) is imported inside each function, never
 * at module scope: the digest registry imports the daily email, which imports
 * this, and listing the digests must not need a database.
 */

const database = async () => (await import("@/lib/db")).db;
import { sql, type SQL } from "drizzle-orm";
import { engagedCall, humanCall } from "@/lib/reports/metricDefinitions";
import {
    clocksForLead,
    medianAndP90,
    type ClockKind,
    type ClockLead,
    type ClockTouch,
    type LeadClock,
    type OwnerHop,
    type StatusChange,
} from "@/lib/leads/clockRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const d = (v: string | Date | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

/** Is E-337 on this database? */
export async function hasLeadClocks(): Promise<boolean> {
    try {
        const db = await database();
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.lead_clocks') IS NOT NULL AS ok`));
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

function group<T extends { lead_id: string }>(rows: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const r of rows) {
        const list = m.get(r.lead_id);
        if (list) list.push(r);
        else m.set(r.lead_id, [r]);
    }
    return m;
}

/** Every clock for every active lead, from the source rows. Reads only. */
export async function computeLeadClocks(now = new Date()): Promise<LeadClock[]> {
    const db = await database();
    const { loadHolidays } = await import("@/lib/calendar/holidays");
    const { timeLimitsResolver } = await import("@/lib/timeLimits/store");
    const [leadRows, touchRows, hopRows, statusRows, limitsOn, holidays] = await Promise.all([
        db.execute(sql`
            SELECT dl.id,
                   dl.created_at AT TIME ZONE 'UTC' AS created_at,
                   (to_jsonb(dl) ->> 'sales_ready_at')::timestamptz AS sales_ready_at,
                   dl.assigned_at,
                   dl.current_owner_id
              FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE AND dl.created_at IS NOT NULL`),
        db.execute(sql`
            SELECT t.dealer_lead_id AS lead_id, t.performed_at AS at, t.performed_by AS by, 'call' AS kind,
                   TRUE AS attempt, (${engagedCall(sql`t`)}) AS contact
              FROM lead_touchpoints t
             WHERE ${humanCall(sql`t`)} AND t.performed_at IS NOT NULL
            UNION ALL
            -- A visit has a date, not a time: read as office opening (10:00 IST) on that day.
            SELECT v.dealer_lead_id, COALESCE((v.actual_visit_date + TIME '10:00') AT TIME ZONE 'Asia/Kolkata', v.updated_at),
                   v.asm_id, 'visit', v.visit_status IN ('visited', 'no_show'), v.visit_status = 'visited'
              FROM lead_visits v
             WHERE v.visit_status IN ('visited', 'no_show')
             ORDER BY 2`),
        db.execute(sql`
            SELECT t.dealer_lead_id AS lead_id, t.performed_at AS at, to_jsonb(t) ->> 'to_owner_id' AS owner_id
              FROM lead_touchpoints t
             WHERE to_jsonb(t) ->> 'to_owner_id' IS NOT NULL AND t.performed_at IS NOT NULL
             ORDER BY t.performed_at`),
        db.execute(sql`
            SELECT h.dealer_lead_id AS lead_id, h.changed_at AS at, h.to_status
              FROM dealer_lead_status_history h
             WHERE h.changed_at IS NOT NULL
             ORDER BY h.changed_at`),
        timeLimitsResolver(),
        loadHolidays(),
    ]);

    const touches = group(
        rowsOf<{ lead_id: string; at: string; by: string | null; kind: "call" | "visit"; attempt: boolean; contact: boolean }>(touchRows).map(
            (r): ClockTouch => ({ ...r, at: new Date(r.at), attempt: Boolean(r.attempt), contact: Boolean(r.contact) }),
        ),
    );
    const hops = group(rowsOf<{ lead_id: string; at: string; owner_id: string }>(hopRows).map((r): OwnerHop => ({ ...r, at: new Date(r.at) })));
    const statuses = group(
        rowsOf<{ lead_id: string; at: string; to_status: string }>(statusRows).map((r): StatusChange => ({ ...r, at: new Date(r.at) })),
    );

    const out: LeadClock[] = [];
    for (const r of rowsOf<{ id: string; created_at: string; sales_ready_at: string | null; assigned_at: string | null; current_owner_id: string | null }>(leadRows)) {
        const lead: ClockLead = {
            id: r.id,
            created_at: new Date(r.created_at),
            sales_ready_at: d(r.sales_ready_at),
            assigned_at: d(r.assigned_at),
            current_owner_id: r.current_owner_id,
        };
        out.push(...clocksForLead(lead, touches.get(r.id) ?? [], hops.get(r.id) ?? [], statuses.get(r.id) ?? [], limitsOn, holidays, now));
    }
    return out;
}

const BATCH = 2000;

/** Rebuild lead_clocks. Returns how many clocks were written; null without E-337. */
export async function refreshLeadClocks(now = new Date()): Promise<{ clocks: number; passed: number } | null> {
    if (!(await hasLeadClocks())) return null;
    const clocks = await computeLeadClocks(now);
    const db = await database();
    const iso = (x: Date | null) => (x ? x.toISOString() : null);
    await db.transaction(async (tx) => {
        // One rebuild at a time across processes (web + worker both tick).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lead_clocks_refresh'))`);
        await tx.execute(sql`DELETE FROM lead_clocks`);
        for (let i = 0; i < clocks.length; i += BATCH) {
            const json = JSON.stringify(
                clocks.slice(i, i + BATCH).map((c) => ({
                    ...c,
                    started_at: iso(c.started_at),
                    ended_at: iso(c.ended_at),
                    first_attempt_at: iso(c.first_attempt_at),
                    first_contact_at: iso(c.first_contact_at),
                    due_at: iso(c.due_at),
                    limit_passed_at: iso(c.limit_passed_at),
                })),
            );
            await tx.execute(sql`
                INSERT INTO lead_clocks (dealer_lead_id, clock, owner_id, owner_inferred, start_inferred, started_at, ended_at,
                                         first_attempt_at, first_attempt_kind, first_contact_at, attempt_working_minutes,
                                         contact_working_minutes, limit_key, limit_value, due_at, limit_passed_at, computed_at)
                SELECT r.dealer_lead_id, r.clock, r.owner_id, r.owner_inferred, r.start_inferred, r.started_at, r.ended_at,
                       r.first_attempt_at, r.first_attempt_kind, r.first_contact_at, r.attempt_working_minutes,
                       r.contact_working_minutes, r.limit_key, r.limit_value, r.due_at, r.limit_passed_at, ${now.toISOString()}::timestamptz
                  FROM jsonb_to_recordset(${json}::jsonb) AS r(
                       dealer_lead_id text, clock text, owner_id text, owner_inferred boolean, start_inferred boolean,
                       started_at timestamptz, ended_at timestamptz, first_attempt_at timestamptz, first_attempt_kind text,
                       first_contact_at timestamptz, attempt_working_minutes int, contact_working_minutes int,
                       limit_key text, limit_value numeric, due_at timestamptz, limit_passed_at timestamptz)
                ON CONFLICT (dealer_lead_id, clock, started_at) DO NOTHING`);
        }
    });
    return { clocks: clocks.length, passed: clocks.filter((c) => c.limit_passed_at).length };
}

// ── Readers ──────────────────────────────────────────────────────────────────

/** `ts` (timestamptz) on an IST day in [from, to]. */
const onIstDays = (ts: SQL, from: string, to: string) =>
    sql`(${ts} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date`;

export type ClockStats = {
    /** Clocks that started in the window. */
    started: number;
    /** …whose limit had fallen due by now. */
    due: number;
    /** …of those, attempted within the limit. */
    in_limit: number;
    /** in_limit / due, 0–100; null when nothing fell due. */
    pct_in_limit: number | null;
    /** Working hours from the clock's start, over the clocks that got there. */
    attempt_median_h: number | null;
    attempt_p90_h: number | null;
    contact_median_h: number | null;
    contact_p90_h: number | null;
};

const EMPTY: ClockStats = {
    started: 0, due: 0, in_limit: 0, pct_in_limit: null,
    attempt_median_h: null, attempt_p90_h: null, contact_median_h: null, contact_p90_h: null,
};

const hours = (m: number | null) => (m == null ? null : Math.round((m / 60) * 10) / 10);

/**
 * One clock's figures for clocks started on IST days [from, to]. Owners
 * optional (a person or a team). Null without E-337.
 */
export async function clockStats(
    clock: ClockKind,
    from: string,
    to: string,
    opts: { ownerIds?: string[] } = {},
): Promise<ClockStats | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const owners = opts.ownerIds?.length ? sql` AND c.owner_id IN ${opts.ownerIds}` : sql``;
    const rows = rowsOf<{ a: number | null; c: number | null; due: boolean; ok: boolean }>(
        await db.execute(sql`
            SELECT c.attempt_working_minutes AS a, c.contact_working_minutes AS c,
                   (c.due_at IS NOT NULL AND c.due_at <= NOW()) AS due,
                   (c.due_at IS NOT NULL AND c.due_at <= NOW() AND c.limit_passed_at IS NULL) AS ok
              FROM lead_clocks c
             WHERE c.clock = ${clock} AND ${onIstDays(sql`c.started_at`, from, to)} ${owners}`),
    );
    if (!rows.length) return { ...EMPTY };
    const a = medianAndP90(rows.filter((r) => r.a != null).map((r) => Number(r.a)));
    const c = medianAndP90(rows.filter((r) => r.c != null).map((r) => Number(r.c)));
    const due = rows.filter((r) => r.due).length;
    const inLimit = rows.filter((r) => r.ok).length;
    return {
        started: rows.length,
        due,
        in_limit: inLimit,
        pct_in_limit: due ? Math.round((inLimit / due) * 100) : null,
        attempt_median_h: hours(a.median),
        attempt_p90_h: hours(a.p90),
        contact_median_h: hours(c.median),
        contact_p90_h: hours(c.p90),
    };
}

/** "Limit passed" events dated on IST days [from, to], any clock. Null without E-337. */
export async function limitsPassed(from: string, to: string, opts: { ownerIds?: string[] } = {}): Promise<number | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const owners = opts.ownerIds?.length ? sql` AND c.owner_id IN ${opts.ownerIds}` : sql``;
    const [r] = rowsOf<{ n: number }>(
        await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM lead_clocks c
             WHERE c.limit_passed_at IS NOT NULL AND ${onIstDays(sql`c.limit_passed_at`, from, to)} ${owners}`),
    );
    return r?.n ?? 0;
}

/** When the clocks were last rebuilt; null when never / without E-337. */
export async function clocksComputedAt(): Promise<string | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const [r] = rowsOf<{ at: string | null }>(await db.execute(sql`SELECT MAX(computed_at)::text AS at FROM lead_clocks`));
    return r?.at ?? null;
}
