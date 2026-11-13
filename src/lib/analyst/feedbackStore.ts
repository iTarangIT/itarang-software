import "server-only";

/**
 * E-380 — thumbs up / down on AI Analyst answers, and the review queue the CEO
 * works through. Raw SQL, not in schema.ts, behind a to_regclass probe: without
 * the table the thumbs are hidden and the queue says so.
 *
 * Rows hold a snapshot of the question and answer, so a reviewer reads what was
 * asked and said without opening someone else's conversation (thread links only
 * open for their owner).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type Rating = "up" | "down";
export type FeedbackStatus = "new" | "reviewed";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasFeedbackTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.analyst_feedback') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

export type MyRating = { rating: Rating; comment: string | null };

/** The caller's own ratings on one of their conversations, by run id. */
export async function ratingsForThread(userId: string, threadId: string): Promise<Record<string, MyRating>> {
    const r = await db.execute(sql`
        SELECT run_id, rating, comment
          FROM analyst_feedback
         WHERE user_id = ${userId} AND thread_id = ${threadId}
    `);
    const out: Record<string, MyRating> = {};
    for (const row of rowsOf<{ run_id: string; rating: Rating; comment: string | null }>(r)) {
        out[row.run_id] = { rating: row.rating, comment: row.comment };
    }
    return out;
}

/** Rate an answer (or re-rate it). A change of mind sends it back to the queue as new. */
export async function saveRating(input: {
    runId: string;
    threadId: string;
    userId: string;
    rating: Rating;
    comment: string | null;
    question: string | null;
    answer: string | null;
}): Promise<void> {
    await db.execute(sql`
        INSERT INTO analyst_feedback (run_id, thread_id, user_id, rating, comment, question, answer)
        VALUES (${input.runId}, ${input.threadId}, ${input.userId}, ${input.rating}, ${input.comment},
                ${input.question}, ${input.answer})
        ON CONFLICT (run_id, user_id) DO UPDATE
           SET rating = EXCLUDED.rating,
               comment = EXCLUDED.comment,
               question = COALESCE(EXCLUDED.question, analyst_feedback.question),
               answer = COALESCE(EXCLUDED.answer, analyst_feedback.answer),
               status = 'new',
               reviewed_by = NULL,
               reviewed_at = NULL,
               review_note = NULL,
               updated_at = now()
    `);
}

/** Take a rating back (the thumb pressed a second time). */
export async function clearRating(runId: string, userId: string): Promise<void> {
    await db.execute(sql`DELETE FROM analyst_feedback WHERE run_id = ${runId} AND user_id = ${userId}`);
}

export type FeedbackRow = {
    id: string;
    run_id: string;
    thread_id: string;
    user_id: string;
    user_name: string | null;
    user_role: string | null;
    rating: Rating;
    comment: string | null;
    question: string | null;
    answer: string | null;
    status: FeedbackStatus;
    reviewed_by_name: string | null;
    reviewed_at: string | null;
    review_note: string | null;
    created_at: string;
    updated_at: string;
};

export type QueueFilter = "new" | "reviewed" | "all";

/** The review queue: thumbs-down first, newest first within each. */
export async function listFeedback(filter: QueueFilter, limit = 200): Promise<FeedbackRow[]> {
    const where =
        filter === "all" ? sql`TRUE` : sql`f.status = ${filter}`;
    const r = await db.execute(sql`
        SELECT f.id, f.run_id, f.thread_id, f.user_id, u.name AS user_name, u.role AS user_role,
               f.rating, f.comment, f.question, f.answer, f.status,
               rv.name AS reviewed_by_name, f.reviewed_at::text AS reviewed_at, f.review_note,
               f.created_at::text AS created_at, f.updated_at::text AS updated_at
          FROM analyst_feedback f
          LEFT JOIN users u  ON u.id::text  = f.user_id
          LEFT JOIN users rv ON rv.id::text = f.reviewed_by
         WHERE ${where}
         ORDER BY (f.rating = 'down') DESC, f.updated_at DESC
         LIMIT ${limit}
    `);
    return rowsOf<FeedbackRow>(r);
}

export type QueueCounts = { new_down: number; new_up: number; reviewed: number };

export async function queueCounts(): Promise<QueueCounts> {
    const r = await db.execute(sql`
        SELECT count(*) FILTER (WHERE status = 'new' AND rating = 'down')::int AS new_down,
               count(*) FILTER (WHERE status = 'new' AND rating = 'up')::int   AS new_up,
               count(*) FILTER (WHERE status = 'reviewed')::int                AS reviewed
          FROM analyst_feedback
    `);
    return rowsOf<QueueCounts>(r)[0] ?? { new_down: 0, new_up: 0, reviewed: 0 };
}

/** Mark a row reviewed (with a note) or send it back to new. Returns false when no such row. */
export async function setReviewed(input: {
    id: string;
    reviewerId: string;
    status: FeedbackStatus;
    note: string | null;
}): Promise<boolean> {
    const r = await db.execute(
        input.status === "reviewed"
            ? sql`
                UPDATE analyst_feedback
                   SET status = 'reviewed', reviewed_by = ${input.reviewerId}, reviewed_at = now(),
                       review_note = ${input.note}, updated_at = now()
                 WHERE id = ${input.id}
                RETURNING id`
            : sql`
                UPDATE analyst_feedback
                   SET status = 'new', reviewed_by = NULL, reviewed_at = NULL,
                       review_note = ${input.note}, updated_at = now()
                 WHERE id = ${input.id}
                RETURNING id`,
    );
    return rowsOf(r).length > 0;
}
