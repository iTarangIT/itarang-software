/**
 * ID 183 — the iTarang team's own credit for working customer files for the
 * dealer, on the Admin / Sales Head "Team scorecard" (Kartik, 24 Oct: the
 * Admin scorecard). The dealer keeps the credit for the file; this line only
 * counts the help, tracked separately.
 *
 * Read from the ACTED_FOR_DEALER audit rows the act-for-dealer gate writes
 * (src/lib/leads/actForDealerGuard.ts recordActorStep) — the same record as
 * the "Assisted by (iTarang)" column (src/lib/exports/assistedBy.ts):
 *
 *   files   customer files the person did at least one step on in [from, to]
 *   steps   every step they did (a step repeated within 30 minutes is one row)
 *
 * Credited to the person who did it (performed_by): Admin and Sales Head from
 * the CRM panel, and each house login in the dealer portal (ID 182 gives each
 * team member their own; the shared house login counts under its own name).
 * `state` / `city` narrow by the customer file. Window in IST days.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { ACTED_FOR_DEALER } from "@/lib/leads/actForDealer";

export type ItarangAssistPerson = { user_id: string | null; name: string; files: number; steps: number };

export type ItarangAssistScore = {
    /** Distinct files across the whole team (a file two people worked counts once). */
    files: number;
    steps: number;
    /** Most files first. */
    people: ItarangAssistPerson[];
};

const IST = "Asia/Kolkata";
const inRange = (col: SQL, from: string, to: string) =>
    sql`(${col} AT TIME ZONE ${IST})::date BETWEEN ${from}::date AND ${to}::date`;

export async function buildItarangAssistScore(f: {
    from: string;
    to: string;
    state?: string | null;
    city?: string | null;
}): Promise<ItarangAssistScore> {
    const st = f.state ? sql` AND lower(trim(l.state)) = lower(trim(${f.state}))` : sql``;
    const ct = f.city ? sql` AND lower(trim(l.city)) = lower(trim(${f.city}))` : sql``;
    const geo = f.state || f.city ? sql` AND l.id IS NOT NULL ${st} ${ct}` : sql``;
    const rows = (await db.execute(sql`
        WITH acted AS (
            SELECT a.performed_by, a.entity_id, a.changes ->> 'by_name' AS by_name
              FROM audit_logs a
              LEFT JOIN leads l ON l.id = a.entity_id
             WHERE a.entity_type = 'lead' AND a.action = ${ACTED_FOR_DEALER}
               AND ${inRange(sql`a.timestamp`, f.from, f.to)} ${geo}
        )
        SELECT x.performed_by::text AS u,
               COALESCE(NULLIF(MAX(usr.name), ''), NULLIF(MAX(x.by_name), ''), 'iTarang') AS name,
               COUNT(DISTINCT x.entity_id)::int AS files,
               COUNT(*)::int AS steps,
               (SELECT COUNT(DISTINCT entity_id) FROM acted)::int AS team_files
          FROM acted x
          LEFT JOIN users usr ON usr.id = x.performed_by
         GROUP BY x.performed_by
    `)) as unknown as Array<{ u: string | null; name: string; files: number; steps: number; team_files: number }>;

    const people = rows
        .map((r) => ({ user_id: r.u, name: String(r.name), files: Number(r.files), steps: Number(r.steps) }))
        .sort((a, b) => b.files - a.files || b.steps - a.steps || a.name.localeCompare(b.name));
    return {
        files: rows.length ? Number(rows[0].team_files) : 0,
        steps: people.reduce((s, p) => s + p.steps, 0),
        people,
    };
}
