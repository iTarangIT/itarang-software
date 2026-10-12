/**
 * Time limits, dated (tracker ID 85). Server only.
 *
 * time_limit_settings (E-337) is append-only: each change is a row with the
 * IST day it takes effect. The value in force on day D is the latest row with
 * effective_from <= D (ties: the later change); no row = the registry default.
 * So a change dated next Monday leaves this week's reports alone, and a past
 * report keeps the limit it was judged by.
 *
 * Every reader goes through here. Without E-337 every read is the default and
 * a save answers 503, so the code is safe on a database in either state.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { istDay } from "@/lib/calendar/officeCalendar";
import {
    TIME_LIMITS,
    TIME_LIMIT_DEFAULTS,
    crossLimitProblem,
    timeLimitDef,
    type TimeLimitKey,
    type TimeLimits,
} from "@/lib/timeLimits/registry";

type Row = { limit_key: string; value: string | number; effective_from: string; changed_at: string };

export type TimeLimitChange = {
    id: number;
    limit_key: string;
    label: string;
    value: number;
    previous: number;
    effective_from: string;
    note: string | null;
    changed_by_name: string | null;
    changed_at: string;
};

export class TimeLimitsUnavailableError extends Error {}

const TTL_MS = 60 * 1000;
let cache: { at: number; rows: Row[] | null } | null = null;

/** Is E-337 on this database? */
export async function hasTimeLimitTable(): Promise<boolean> {
    try {
        const r = (await db.execute(sql`SELECT to_regclass('public.time_limit_settings') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

/** Every change, oldest first; null without E-337. Cached a minute. */
async function changes(): Promise<Row[] | null> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
    let rows: Row[] | null = null;
    try {
        if (await hasTimeLimitTable()) {
            rows = (await db.execute(sql`
                SELECT limit_key, value, effective_from::text AS effective_from, changed_at::text AS changed_at
                  FROM time_limit_settings
                 ORDER BY effective_from, changed_at, id
            `)) as unknown as Row[];
        }
    } catch (e) {
        console.warn("[timeLimits] read failed — using the defaults:", e instanceof Error ? e.message : e);
    }
    cache = { at: Date.now(), rows };
    return rows;
}

/** Pure: the values in force on `day` (IST YYYY-MM-DD) given the change rows. */
export function limitsOn(day: string, rows: readonly Row[] | null): TimeLimits {
    const out = { ...TIME_LIMIT_DEFAULTS };
    for (const r of rows ?? []) {
        // Rows are oldest first, so the last one dated on or before `day` wins.
        if (r.effective_from <= day && r.limit_key in out) out[r.limit_key as TimeLimitKey] = Number(r.value);
    }
    return out;
}

/** The limits in force on an IST day (default: today). Never throws. */
export async function getTimeLimits(day: string = istDay(new Date())): Promise<TimeLimits> {
    return limitsOn(day, await changes());
}

/**
 * A resolver for many days at once (the clock refresh judges each clock by the
 * limit in force on the day it started): one read, then pure lookups.
 */
export async function timeLimitsResolver(): Promise<(day: string) => TimeLimits> {
    const rows = await changes();
    const memo = new Map<string, TimeLimits>();
    return (day) => {
        let v = memo.get(day);
        if (!v) memo.set(day, (v = limitsOn(day, rows)));
        return v;
    };
}

/** The change log, newest first, with the value each change replaced. */
export async function timeLimitLog(limit = 200): Promise<TimeLimitChange[]> {
    if (!(await hasTimeLimitTable())) return [];
    const rows = (await db.execute(sql`
        SELECT t.id::int AS id, t.limit_key, t.value, t.effective_from::text AS effective_from, t.note,
               t.changed_at::text AS changed_at, u.name AS changed_by_name,
               (SELECT p.value FROM time_limit_settings p
                 WHERE p.limit_key = t.limit_key
                   AND (p.effective_from, p.changed_at, p.id) < (t.effective_from, t.changed_at, t.id)
                 ORDER BY p.effective_from DESC, p.changed_at DESC, p.id DESC LIMIT 1) AS previous
          FROM time_limit_settings t
          LEFT JOIN users u ON u.id = t.changed_by
         ORDER BY t.changed_at DESC, t.id DESC
         LIMIT ${limit}
    `)) as unknown as Array<Omit<TimeLimitChange, "label" | "previous"> & { value: string; previous: string | null }>;
    return rows.map((r) => ({
        ...r,
        value: Number(r.value),
        previous: r.previous == null ? (timeLimitDef(r.limit_key)?.default ?? 0) : Number(r.previous),
        label: timeLimitDef(r.limit_key)?.label ?? r.limit_key,
    }));
}

/** Future-dated changes not in force yet, by limit — shown beside the current value. */
export async function scheduledChanges(today: string = istDay(new Date())): Promise<Record<string, { value: number; effective_from: string }>> {
    const out: Record<string, { value: number; effective_from: string }> = {};
    for (const r of (await changes()) ?? []) {
        if (r.effective_from > today) out[r.limit_key] = { value: Number(r.value), effective_from: r.effective_from };
    }
    return out;
}

/**
 * Record a change. `effectiveFrom` must be today or later (IST) — a limit is
 * never changed retroactively. Throws a plain Error with a reason the screen
 * can show; TimeLimitsUnavailableError without E-337.
 */
export async function setTimeLimit(input: {
    key: string;
    value: number;
    effectiveFrom: string;
    note: string | null;
    actorId: string;
}): Promise<void> {
    const def = timeLimitDef(input.key);
    if (!def) throw new Error("Unknown time limit.");
    if (!Number.isInteger(input.value) || input.value < def.min || input.value > def.max) {
        throw new Error(`${def.label}: enter a whole number from ${def.min} to ${def.max}.`);
    }
    const today = istDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || input.effectiveFrom < today) {
        throw new Error("A change takes effect today or later, never in the past.");
    }
    if (!(await hasTimeLimitTable())) throw new TimeLimitsUnavailableError("Time limits are not set up on this server (E-337).");

    // Cross-limit rules, on the values that would be in force from that day.
    const would = { ...limitsOn(input.effectiveFrom, await changes()), [input.key]: input.value } as TimeLimits;
    const problem = crossLimitProblem(would);
    if (problem) throw new Error(problem);

    await db.execute(sql`
        INSERT INTO time_limit_settings (limit_key, value, effective_from, note, changed_by)
        VALUES (${input.key}, ${input.value}, ${input.effectiveFrom}::date, ${input.note}, ${input.actorId}::uuid)
    `);
    cache = null;
}

export { TIME_LIMITS };
