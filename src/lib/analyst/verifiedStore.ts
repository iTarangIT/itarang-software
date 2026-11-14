import "server-only";

/**
 * E-382 — verified AI Analyst queries. Raw SQL, not in schema.ts, behind a to_regclass probe:
 * without the table nothing is matched, no badge shows and the Verify control is hidden.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { normalizeQuestion, normalizeSql, rankVerified, type VerifiedMatch } from "./verified";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasVerifiedTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.analyst_verified_queries') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

export type VerifiedRow = {
    id: string;
    connection_id: string;
    question: string;
    sql: string;
    source_run_id: string | null;
    verified_by: string;
    verified_by_name: string | null;
    verified_at: string;
    note: string | null;
};

/** Mark a run's query verified. Re-verifying the same SQL updates the question / note. */
export async function verifyQuery(input: {
    connectionId: string;
    question: string;
    sql: string;
    sourceRunId: string;
    userId: string;
    note: string | null;
}): Promise<string> {
    const r = await db.execute(sql`
        INSERT INTO analyst_verified_queries
               (connection_id, question, question_norm, sql, sql_norm, source_run_id, verified_by, note)
        VALUES (${input.connectionId}, ${input.question}, ${normalizeQuestion(input.question)}, ${input.sql},
                ${normalizeSql(input.sql)}, ${input.sourceRunId}, ${input.userId}, ${input.note})
        ON CONFLICT (connection_id, sql_norm) WHERE active DO UPDATE
           SET question = EXCLUDED.question,
               question_norm = EXCLUDED.question_norm,
               source_run_id = EXCLUDED.source_run_id,
               verified_by = EXCLUDED.verified_by,
               verified_at = now(),
               note = COALESCE(EXCLUDED.note, analyst_verified_queries.note),
               updated_at = now()
        RETURNING id
    `);
    return rowsOf<{ id: string }>(r)[0]!.id;
}

/** Take a verification back. The row stays (inactive) as history. */
export async function unverifyQuery(id: string): Promise<boolean> {
    const r = await db.execute(sql`
        UPDATE analyst_verified_queries SET active = false, updated_at = now()
         WHERE id = ${id} AND active
        RETURNING id
    `);
    return rowsOf(r).length > 0;
}

export async function listVerified(limit = 500): Promise<VerifiedRow[]> {
    const r = await db.execute(sql`
        SELECT v.id, v.connection_id, v.question, v.sql, v.source_run_id, v.verified_by,
               u.name AS verified_by_name, v.verified_at::text AS verified_at, v.note
          FROM analyst_verified_queries v
          LEFT JOIN users u ON u.id::text = v.verified_by
         WHERE v.active
         ORDER BY v.verified_at DESC
         LIMIT ${limit}
    `);
    return rowsOf<VerifiedRow>(r);
}

/** The active verified queries on one source, closest to the question first. */
export async function matchVerified(connectionId: string, question: string, k = 3): Promise<VerifiedMatch[]> {
    const r = await db.execute(sql`
        SELECT id, question, sql FROM analyst_verified_queries
         WHERE active AND connection_id = ${connectionId}
         ORDER BY verified_at DESC
         LIMIT 500
    `);
    return rankVerified(question, rowsOf<{ id: string; question: string; sql: string }>(r), k);
}

export type VerifiedMark = { id: string; question: string };

/** The verified query a run's SQL is, if any. */
export async function verifiedForSql(connectionId: string, runSql: string | null): Promise<VerifiedMark | null> {
    if (!runSql?.trim()) return null;
    const r = await db.execute(sql`
        SELECT id, question FROM analyst_verified_queries
         WHERE active AND connection_id = ${connectionId} AND sql_norm = ${normalizeSql(runSql)}
         LIMIT 1
    `);
    return rowsOf<VerifiedMark>(r)[0] ?? null;
}
