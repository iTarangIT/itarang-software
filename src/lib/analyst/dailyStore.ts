// 251 item 23 — "Email me this every morning" (E-385 analyst_daily_questions).
//
// A person presses the envelope under an answer; the question is asked afresh each morning
// and mailed to them by the analyst_daily digest (src/lib/digests/kinds/analyst-daily.ts).
// Raw SQL behind to_regclass: without E-385 the envelope is hidden and the mail finds nobody.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/** Most questions one person can have mailed each morning (each one is a run on the agent). */
export const DAILY_QUESTIONS_MAX = 5;

export async function hasDailyTable(): Promise<boolean> {
    try {
        const r = (await db.execute(
            sql`SELECT to_regclass('public.analyst_daily_questions') IS NOT NULL AS ok`,
        )) as unknown as Array<{ ok: boolean }>;
        return r[0]?.ok === true;
    } catch {
        return false;
    }
}

export type DailyQuestion = {
    id: string;
    user_id: string;
    connection_id: string;
    question: string;
    source_run_id: string | null;
    created_at: string;
};

/** The person's live morning questions, oldest first (the order the mail lists them). */
export async function listDaily(userId: string): Promise<DailyQuestion[]> {
    return (await db.execute(sql`
        SELECT id, user_id, connection_id, question, source_run_id, created_at::text AS created_at
          FROM analyst_daily_questions
         WHERE user_id = ${userId} AND active
         ORDER BY created_at ASC
    `)) as unknown as DailyQuestion[];
}

export type AddDailyResult =
    | { ok: true; item: DailyQuestion; already: boolean }
    | { ok: false; reason: "full" };

/** Start mailing a question. Already on the list = the existing row; over the cap = refused. */
export async function addDaily(input: {
    userId: string;
    connectionId: string;
    question: string;
    sourceRunId: string | null;
}): Promise<AddDailyResult> {
    const question = input.question.trim();
    const mine = await listDaily(input.userId);
    const same = mine.find((q) => q.question.trim().toLowerCase() === question.toLowerCase());
    if (same) return { ok: true, item: same, already: true };
    if (mine.length >= DAILY_QUESTIONS_MAX) return { ok: false, reason: "full" };
    const rows = (await db.execute(sql`
        INSERT INTO analyst_daily_questions (user_id, connection_id, question, source_run_id)
        VALUES (${input.userId}, ${input.connectionId}, ${question}, ${input.sourceRunId})
        ON CONFLICT (user_id, lower(btrim(question))) WHERE active DO NOTHING
        RETURNING id, user_id, connection_id, question, source_run_id, created_at::text AS created_at
    `)) as unknown as DailyQuestion[];
    if (rows[0]) return { ok: true, item: rows[0], already: false };
    // Lost a race with a second click: the row is there now.
    const again = (await listDaily(input.userId)).find((q) => q.question.trim().toLowerCase() === question.toLowerCase());
    return again ? { ok: true, item: again, already: true } : { ok: false, reason: "full" };
}

/** Stop mailing one of the person's own questions. False when it is not theirs or already stopped. */
export async function stopDaily(id: string, userId: string): Promise<boolean> {
    const rows = (await db.execute(sql`
        UPDATE analyst_daily_questions
           SET active = false, stopped_at = now()
         WHERE id = ${id} AND user_id = ${userId} AND active
        RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length > 0;
}

/** Everyone with at least one live morning question, as digest people (active users with an email). */
export async function dailyPeople(roles: readonly string[]): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
    if (roles.length === 0) return [];
    const rows = (await db.execute(sql`
        SELECT u.id::text AS id, COALESCE(u.name, u.email) AS name, trim(u.email) AS email, lower(u.role) AS role
          FROM users u
         WHERE u.is_active = TRUE AND u.email IS NOT NULL AND trim(u.email) <> ''
           AND lower(u.role) IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})
           AND EXISTS (SELECT 1 FROM analyst_daily_questions q WHERE q.user_id = u.id::text AND q.active)
         ORDER BY 2
    `)) as unknown as Array<{ id: string; name: string; email: string; role: string }>;
    return rows;
}
