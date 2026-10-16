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
 * E-343 (15 Oct rework): the Hot / retry / quote clocks are computed only
 * where lead_clocks accepts them, and every newly passed limit is copied once
 * into lead_limit_events — the fixed "Limit passed" record that the event
 * log, the lead timeline and the daily email read. A miss recorded there never
 * changes, whatever later happens to the lead, the holidays or the limits.
 * Per-person figures leave out owner_inferred clocks (no owner on record).
 *
 * `db` (and the modules that hold it) is imported inside each function, never
 * at module scope: the digest registry imports the daily email, which imports
 * this, and listing the digests must not need a database.
 */

const database = async () => (await import("@/lib/db")).db;
import { sql, type SQL } from "drizzle-orm";
import { engagedCall, humanCall } from "@/lib/reports/metricDefinitions";
import {
    ALL_CLOCK_KINDS,
    BASE_CLOCK_KINDS,
    clocksForLead,
    medianAndP90,
    type ClockKind,
    type ClockLead,
    type ClockTouch,
    type InterestChange,
    type LeadClock,
    type OwnerHop,
    type QuoteGate,
    type StatusChange,
} from "@/lib/leads/clockRules";
import { timeLimitDef } from "@/lib/timeLimits/registry";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const d = (v: string | Date | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

async function tableExists(name: string): Promise<boolean> {
    try {
        const db = await database();
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS ok`));
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

/** Is E-337 on this database? */
export async function hasLeadClocks(): Promise<boolean> {
    return tableExists("lead_clocks");
}

/** Is E-343 (fixed limit events, the wider clock CHECK) on this database? */
export async function hasLimitEvents(): Promise<boolean> {
    return tableExists("lead_limit_events");
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
export async function computeLeadClocks(now = new Date(), opts: { kinds?: readonly ClockKind[] } = {}): Promise<LeadClock[]> {
    const db = await database();
    const { holidaysAsOf } = await import("@/lib/calendar/holidays");
    const { timeLimitsResolver } = await import("@/lib/timeLimits/store");
    const kinds = new Set<ClockKind>(opts.kinds ?? ((await hasLimitEvents()) ? ALL_CLOCK_KINDS : BASE_CLOCK_KINDS));
    const wantsHot = kinds.has("hot_assign") || kinds.has("hot_owner");
    // E-304's full interest history, where present (manual overrides alone miss automatic moves).
    const interestHistory =
        wantsHot && (await tableExists("dealer_lead_interest_history"))
            ? sql`
                UNION ALL
                SELECT ih.dealer_lead_id, ih.changed_at, lower(ih.to_level)
                  FROM dealer_lead_interest_history ih
                 WHERE ih.changed_at IS NOT NULL AND ih.to_level IS NOT NULL`
            : sql``;
    const [leadRows, touchRows, hopRows, statusRows, interestRows, quoteRows, limitsOn, holidays] = await Promise.all([
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
        // Interest history (Hot clocks): every audited change, plus the lead's
        // current level at the moment the trigger stamped it, so a level set by
        // a path that wrote no audit row still counts.
        wantsHot
            ? db.execute(sql`
                SELECT o.dealer_lead_id AS lead_id, o.changed_at AS at, lower(o.to_value) AS "to"
                  FROM interest_level_overrides o
                 WHERE o.changed_at IS NOT NULL AND o.to_value IS NOT NULL
                ${interestHistory}
                UNION ALL
                SELECT dl.id, COALESCE((to_jsonb(dl) ->> 'interest_changed_at')::timestamptz, dl.created_at),
                       lower(to_jsonb(dl) ->> 'interest_level')
                  FROM dealer_leads dl
                 WHERE dl.is_active IS NOT FALSE AND dl.created_at IS NOT NULL
                   AND to_jsonb(dl) ->> 'interest_level' IS NOT NULL
                 ORDER BY 2`)
            : Promise.resolve([]),
        // Quotes that went to the CEO queue (not auto-approved by the price check).
        kinds.has("quote")
            ? db.execute(sql`
                SELECT c.dealer_lead_id AS lead_id, c.created_at AS submitted_at,
                       CASE WHEN c.approval_status IN ('approved', 'rejected') THEN c.approved_at END AS decided_at,
                       c.withdrawn_at, c.approved_by AS decided_by
                  FROM dealer_lead_commercials c
                 WHERE c.event_type IN ('quote_issue', 'quote_revision')
                   AND c.created_at IS NOT NULL
                   AND COALESCE(c.approval_mode, '') <> 'auto'
                   AND (c.approval_status = 'pending' OR c.approved_by IS NOT NULL)
                 ORDER BY c.created_at`)
            : Promise.resolve([]),
        timeLimitsResolver(),
        holidaysAsOf(),
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
    const interest = group(rowsOf<{ lead_id: string; at: string; to: string }>(interestRows).map((r): InterestChange => ({ ...r, at: new Date(r.at) })));
    const quotes = group(
        rowsOf<{ lead_id: string; submitted_at: string; decided_at: string | null; withdrawn_at: string | null; decided_by: string | null }>(quoteRows).map(
            (r): QuoteGate => ({
                lead_id: r.lead_id,
                submitted_at: new Date(r.submitted_at),
                decided_at: d(r.decided_at),
                withdrawn_at: d(r.withdrawn_at),
                decided_by: r.decided_by,
            }),
        ),
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
        out.push(
            ...clocksForLead(lead, touches.get(r.id) ?? [], hops.get(r.id) ?? [], statuses.get(r.id) ?? [], limitsOn, holidays, now, {
                kinds,
                interest: interest.get(r.id) ?? [],
                quotes: quotes.get(r.id) ?? [],
            }),
        );
    }
    return out;
}

const BATCH = 2000;

/** Rebuild lead_clocks and record new misses. Null without E-337. */
export async function refreshLeadClocks(now = new Date()): Promise<{ clocks: number; passed: number; recorded: number } | null> {
    if (!(await hasLeadClocks())) return null;
    const withEvents = await hasLimitEvents();
    const clocks = await computeLeadClocks(now, { kinds: withEvents ? ALL_CLOCK_KINDS : BASE_CLOCK_KINDS });
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
    const recorded = withEvents ? await recordLimitEvents(clocks) : 0;
    return { clocks: clocks.length, passed: clocks.filter((c) => c.limit_passed_at).length, recorded };
}

/**
 * Copy newly passed limits into lead_limit_events (E-343), once: a row already
 * recorded for the same clock is never touched, so the record is the miss as
 * it stood on the day. Returns how many were added.
 */
export async function recordLimitEvents(clocks: readonly LeadClock[]): Promise<number> {
    const passed = clocks.filter((c) => c.limit_passed_at && c.limit_key && c.limit_value != null);
    if (!passed.length) return 0;
    const db = await database();
    let added = 0;
    for (let i = 0; i < passed.length; i += BATCH) {
        const json = JSON.stringify(
            passed.slice(i, i + BATCH).map((c) => ({
                dealer_lead_id: c.dealer_lead_id,
                clock: c.clock,
                clock_started_at: c.started_at.toISOString(),
                limit_key: c.limit_key,
                limit_value: c.limit_value,
                limit_unit: (c.limit_key && timeLimitDef(c.limit_key)?.unit) ?? "working_hours",
                passed_at: c.limit_passed_at!.toISOString(),
                owner_id: c.owner_id,
                owner_inferred: c.owner_inferred,
            })),
        );
        const r = rowsOf<{ n: number }>(
            await db.execute(sql`
                WITH ins AS (
                    INSERT INTO lead_limit_events (dealer_lead_id, clock, clock_started_at, limit_key, limit_value, limit_unit,
                                                   passed_at, owner_id, owner_inferred)
                    SELECT r.dealer_lead_id, r.clock, r.clock_started_at, r.limit_key, r.limit_value, r.limit_unit,
                           r.passed_at, r.owner_id, r.owner_inferred
                      FROM jsonb_to_recordset(${json}::jsonb) AS r(
                           dealer_lead_id text, clock text, clock_started_at timestamptz, limit_key text, limit_value numeric,
                           limit_unit text, passed_at timestamptz, owner_id text, owner_inferred boolean)
                    ON CONFLICT (dealer_lead_id, clock, clock_started_at) DO NOTHING
                    RETURNING 1)
                SELECT COUNT(*)::int AS n FROM ins`),
        );
        added += Number(r[0]?.n ?? 0);
    }
    return added;
}

// ── Readers ──────────────────────────────────────────────────────────────────

/** `ts` (timestamptz) on an IST day in [from, to]. */
const onIstDays = (ts: SQL, from: string, to: string) =>
    sql`(${ts} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date`;

/** Per-person filter: those owners, and only clocks whose owner is on record (ID 86). */
const ownedBy = (ownerIds: string[] | undefined) =>
    ownerIds?.length ? sql` AND c.owner_id IN ${ownerIds} AND c.owner_inferred = false` : sql``;

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
 * optional (a person or a team) — then inferred owners are left out. Null
 * without E-337.
 */
export async function clockStats(
    clock: ClockKind,
    from: string,
    to: string,
    opts: { ownerIds?: string[] } = {},
): Promise<ClockStats | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const rows = rowsOf<{ a: number | null; c: number | null; due: boolean; ok: boolean }>(
        await db.execute(sql`
            SELECT c.attempt_working_minutes AS a, c.contact_working_minutes AS c,
                   (c.due_at IS NOT NULL AND c.due_at <= NOW()) AS due,
                   (c.due_at IS NOT NULL AND c.due_at <= NOW() AND c.limit_passed_at IS NULL) AS ok
              FROM lead_clocks c
             WHERE c.clock = ${clock} AND ${onIstDays(sql`c.started_at`, from, to)} ${ownedBy(opts.ownerIds)}`),
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

/**
 * "Limit passed" events dated on IST days [from, to], any clock. Reads the
 * fixed records (E-343) when present, else the derived clocks. Per person
 * (ownerIds) leaves out misses whose owner is inferred. Null without E-337.
 */
export async function limitsPassed(from: string, to: string, opts: { ownerIds?: string[] } = {}): Promise<number | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const [r] = (await hasLimitEvents())
        ? rowsOf<{ n: number }>(
              await db.execute(sql`
                SELECT COUNT(*)::int AS n FROM lead_limit_events c
                 WHERE ${onIstDays(sql`c.passed_at`, from, to)} ${ownedBy(opts.ownerIds)}`),
          )
        : rowsOf<{ n: number }>(
              await db.execute(sql`
                SELECT COUNT(*)::int AS n FROM lead_clocks c
                 WHERE c.limit_passed_at IS NOT NULL AND ${onIstDays(sql`c.limit_passed_at`, from, to)} ${ownedBy(opts.ownerIds)}`),
          );
    return Number(r?.n ?? 0);
}

/** Per owner, limits passed on IST days [from, to] (inferred owners left out). */
export async function limitsPassedByOwner(from: string, to: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!(await hasLeadClocks())) return out;
    const db = await database();
    const rows = (await hasLimitEvents())
        ? rowsOf<{ owner_id: string; n: number }>(
              await db.execute(sql`
                SELECT c.owner_id, COUNT(*)::int AS n FROM lead_limit_events c
                 WHERE c.owner_id IS NOT NULL AND c.owner_inferred = false AND ${onIstDays(sql`c.passed_at`, from, to)}
                 GROUP BY c.owner_id`),
          )
        : rowsOf<{ owner_id: string; n: number }>(
              await db.execute(sql`
                SELECT c.owner_id, COUNT(*)::int AS n FROM lead_clocks c
                 WHERE c.limit_passed_at IS NOT NULL AND c.owner_id IS NOT NULL AND c.owner_inferred = false
                   AND ${onIstDays(sql`c.limit_passed_at`, from, to)}
                 GROUP BY c.owner_id`),
          );
    for (const r of rows) out.set(r.owner_id, Number(r.n));
    return out;
}

/** Per owner, the median working hours from assignment to first attempt (owner clocks started on [from, to]). */
export async function ownerClockMedianByOwner(from: string, to: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!(await hasLeadClocks())) return out;
    const db = await database();
    const rows = rowsOf<{ owner_id: string; m: number | null }>(
        await db.execute(sql`
            SELECT c.owner_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY c.attempt_working_minutes) AS m
              FROM lead_clocks c
             WHERE c.clock = 'owner' AND c.owner_id IS NOT NULL AND c.owner_inferred = false
               AND c.attempt_working_minutes IS NOT NULL AND ${onIstDays(sql`c.started_at`, from, to)}
             GROUP BY c.owner_id`),
    );
    for (const r of rows) if (r.m != null) out.set(r.owner_id, hours(Number(r.m))!);
    return out;
}

export type LimitPassedEvent = {
    dealer_lead_id: string;
    dealer_name: string | null;
    clock: ClockKind;
    limit_key: string;
    limit_value: number;
    limit_unit: string;
    passed_at: string;
    owner_id: string | null;
    owner_name: string | null;
    owner_inferred: boolean;
};

/**
 * Fixed "Limit passed" records: for one lead (its timeline), or the oldest
 * still-unanswered ones (the daily email's Oldest overdue). [] without E-343.
 */
export async function limitPassedEvents(opts: { leadId?: string; openOnly?: boolean; limit?: number }): Promise<LimitPassedEvent[]> {
    if (!(await hasLimitEvents())) return [];
    const db = await database();
    const lead = opts.leadId ? sql` AND e.dealer_lead_id = ${opts.leadId}` : sql``;
    // Still open = its clock is still running unattempted (lead_clocks agrees today).
    const open = opts.openOnly
        ? sql` AND EXISTS (SELECT 1 FROM lead_clocks c
                            WHERE c.dealer_lead_id = e.dealer_lead_id AND c.clock = e.clock AND c.started_at = e.clock_started_at
                              AND c.first_attempt_at IS NULL AND (c.ended_at IS NULL OR c.ended_at > NOW()))`
        : sql``;
    return rowsOf<LimitPassedEvent>(
        await db.execute(sql`
            SELECT e.dealer_lead_id, dl.dealer_name, e.clock, e.limit_key, e.limit_value::float AS limit_value, e.limit_unit,
                   e.passed_at::text AS passed_at, e.owner_id, u.name AS owner_name, e.owner_inferred
              FROM lead_limit_events e
              LEFT JOIN dealer_leads dl ON dl.id = e.dealer_lead_id
              LEFT JOIN users u ON u.id::text = e.owner_id
             WHERE TRUE ${lead} ${open}
             ORDER BY e.passed_at ${opts.openOnly ? sql`ASC` : sql`DESC`}
             LIMIT ${opts.limit ?? 200}`),
    );
}

/** Of these leads, the ones with a running clock past its limit right now (the "Past a limit" chip). */
export async function leadsPastALimit(leadIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!leadIds.length || !(await hasLeadClocks())) return out;
    const db = await database();
    const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
            SELECT DISTINCT c.dealer_lead_id AS id FROM lead_clocks c
             WHERE c.dealer_lead_id IN ${[...leadIds]}
               AND c.limit_passed_at IS NOT NULL AND c.first_attempt_at IS NULL
               AND (c.ended_at IS NULL OR c.ended_at > NOW())
               AND c.clock <> 'quote'`),
    );
    for (const r of rows) out.add(r.id);
    return out;
}

/** When the clocks were last rebuilt; null when never / without E-337. */
export async function clocksComputedAt(): Promise<string | null> {
    if (!(await hasLeadClocks())) return null;
    const db = await database();
    const [r] = rowsOf<{ at: string | null }>(await db.execute(sql`SELECT MAX(computed_at)::text AS at FROM lead_clocks`));
    return r?.at ?? null;
}
