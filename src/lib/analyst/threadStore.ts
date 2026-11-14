import "server-only";

/**
 * E-381 — the CRM's own record of each AI Analyst conversation: its title (or the user's
 * rename), pin, archive, soft delete and share link, and every question asked (search,
 * personal starter questions). Raw SQL, not in schema.ts, behind a to_regclass probe: without
 * the table the list falls back to the agent's and the controls are hidden.
 */
import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { cleanThread } from "./metricRules";
import { cleanTitle, mergeThreads, sortThreads, type ListThread, type ThreadMeta } from "./threadList";
import type { Thread } from "./types";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasThreadTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.analyst_threads') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

/** The questions column keeps at most this much (newest last); search and starters need no more. */
const QUESTIONS_MAX = 20_000;

/** A question was asked on a thread: create its row, or count the question on it. */
export async function recordAsk(input: {
    userId: string;
    threadId: string;
    question: string;
    connectionId: string;
}): Promise<void> {
    const question = input.question.replace(/\s+/g, " ").trim();
    await db.execute(sql`
        INSERT INTO analyst_threads (thread_id, user_id, title, first_question, questions, connection_id, run_count, last_asked_at)
        VALUES (${input.threadId}, ${input.userId}, ${cleanTitle(question)}, ${question}, ${question},
                ${input.connectionId}, 1, now())
        ON CONFLICT (thread_id) DO UPDATE
           SET questions = right(analyst_threads.questions || E'\n' || EXCLUDED.questions, ${QUESTIONS_MAX}),
               connection_id = EXCLUDED.connection_id,
               run_count = analyst_threads.run_count + 1,
               last_asked_at = now(),
               -- Asking in an archived conversation brings it back to the list.
               archived_at = NULL,
               updated_at = now()
         WHERE analyst_threads.user_id = EXCLUDED.user_id
    `);
}

/**
 * The first time the CRM sees a thread the agent already has (asked before E-381), its row is
 * created from the agent's own record, so its pin / rename / archive have somewhere to live.
 */
export async function ensureThreadRow(input: {
    userId: string;
    threadId: string;
    title: string;
    connectionId: string | null;
    runCount: number;
    lastAskedAt: string | null;
}): Promise<void> {
    const title = cleanTitle(input.title) || "Conversation";
    await db.execute(sql`
        INSERT INTO analyst_threads (thread_id, user_id, title, first_question, questions, connection_id, run_count, last_asked_at)
        VALUES (${input.threadId}, ${input.userId}, ${title}, ${input.title}, ${input.title}, ${input.connectionId},
                ${input.runCount}, COALESCE(${input.lastAskedAt}::timestamptz, now()))
        ON CONFLICT (thread_id) DO NOTHING
    `);
}

type MetaRow = Omit<ThreadMeta, "shared"> & { share_token: string | null };

const META_COLUMNS = sql`thread_id, title, title_custom, questions, connection_id, run_count,
    last_asked_at::text AS last_asked_at, pinned_at::text AS pinned_at, archived_at::text AS archived_at,
    deleted_at::text AS deleted_at, share_token`;

function toMeta(row: MetaRow): ThreadMeta {
    const { share_token, ...rest } = row;
    return { ...rest, shared: Boolean(share_token) };
}

/** Every one of the caller's rows, deleted ones included (the merge drops them). */
export async function threadMetaFor(userId: string, limit = 1000): Promise<ThreadMeta[]> {
    const r = await db.execute(sql`
        SELECT ${META_COLUMNS}
          FROM analyst_threads
         WHERE user_id = ${userId}
         ORDER BY last_asked_at DESC
         LIMIT ${limit}
    `);
    return rowsOf<MetaRow>(r).map(toMeta);
}

export async function threadMeta(userId: string, threadId: string): Promise<(ThreadMeta & { share_token: string | null }) | null> {
    const r = await db.execute(sql`
        SELECT ${META_COLUMNS} FROM analyst_threads WHERE user_id = ${userId} AND thread_id = ${threadId}
    `);
    const row = rowsOf<MetaRow>(r)[0];
    return row ? { ...toMeta(row), share_token: row.share_token } : null;
}

export type ThreadPatch = { title?: string; pinned?: boolean; archived?: boolean };

/** Rename / pin / archive one of the caller's threads. False when there is no such row. */
export async function patchThread(userId: string, threadId: string, patch: ThreadPatch): Promise<boolean> {
    const sets = [sql`updated_at = now()`];
    if (patch.title !== undefined) {
        const title = cleanTitle(patch.title);
        // An empty name goes back to the first question.
        sets.push(
            title
                ? sql`title = ${title}, title_custom = true`
                : sql`title = left(COALESCE(first_question, title), 120), title_custom = false`,
        );
    }
    if (patch.pinned !== undefined) sets.push(patch.pinned ? sql`pinned_at = COALESCE(pinned_at, now())` : sql`pinned_at = NULL`);
    if (patch.archived !== undefined) {
        sets.push(patch.archived ? sql`archived_at = COALESCE(archived_at, now())` : sql`archived_at = NULL`);
    }
    const r = await db.execute(sql`
        UPDATE analyst_threads SET ${sql.join(sets, sql`, `)}
         WHERE user_id = ${userId} AND thread_id = ${threadId} AND deleted_at IS NULL
        RETURNING thread_id
    `);
    return rowsOf(r).length > 0;
}

/** Delete from the caller's list. Nothing is removed: the row is only marked (item 11). Sharing stops. */
export async function softDeleteThread(userId: string, threadId: string): Promise<boolean> {
    const r = await db.execute(sql`
        UPDATE analyst_threads
           SET deleted_at = now(), pinned_at = NULL, share_token = NULL, shared_at = NULL, updated_at = now()
         WHERE user_id = ${userId} AND thread_id = ${threadId} AND deleted_at IS NULL
        RETURNING thread_id
    `);
    return rowsOf(r).length > 0;
}

export async function restoreThread(userId: string, threadId: string): Promise<boolean> {
    const r = await db.execute(sql`
        UPDATE analyst_threads SET deleted_at = NULL, updated_at = now()
         WHERE user_id = ${userId} AND thread_id = ${threadId}
        RETURNING thread_id
    `);
    return rowsOf(r).length > 0;
}

/** The thread's share token, made on first use. Null when there is no such (live) row. */
export async function ensureShareToken(userId: string, threadId: string): Promise<string | null> {
    const token = randomBytes(24).toString("base64url");
    const r = await db.execute(sql`
        UPDATE analyst_threads
           SET share_token = COALESCE(share_token, ${token}),
               shared_at = COALESCE(shared_at, now()),
               updated_at = now()
         WHERE user_id = ${userId} AND thread_id = ${threadId} AND deleted_at IS NULL
        RETURNING share_token
    `);
    return rowsOf<{ share_token: string }>(r)[0]?.share_token ?? null;
}

export async function revokeShare(userId: string, threadId: string): Promise<boolean> {
    const r = await db.execute(sql`
        UPDATE analyst_threads SET share_token = NULL, shared_at = NULL, updated_at = now()
         WHERE user_id = ${userId} AND thread_id = ${threadId}
        RETURNING thread_id
    `);
    return rowsOf(r).length > 0;
}

export type SharedThread = { thread_id: string; user_id: string; title: string; owner_name: string | null; shared_at: string | null };

export async function threadByShareToken(token: string): Promise<SharedThread | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const r = await db.execute(sql`
        SELECT t.thread_id, t.user_id, t.title, u.name AS owner_name, t.shared_at::text AS shared_at
          FROM analyst_threads t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.share_token = ${token} AND t.deleted_at IS NULL
    `);
    return rowsOf<SharedThread>(r)[0] ?? null;
}

/** The caller's questions, newest thread first, for personal starter questions. */
export async function recentQuestions(userId: string, threads = 40): Promise<string[]> {
    const r = await db.execute(sql`
        SELECT questions FROM analyst_threads
         WHERE user_id = ${userId} AND deleted_at IS NULL
         ORDER BY last_asked_at DESC
         LIMIT ${threads}
    `);
    return rowsOf<{ questions: string }>(r).flatMap((row) => row.questions.split("\n").reverse());
}

/**
 * The caller's whole list (active and archived; deleted dropped): the agent's threads with the
 * caller's prefix merged with the CRM's rows. Without E-381 it is the agent's list alone.
 */
export async function ownThreadList(user: { id: string; prefix: string }, agentThreads: Thread[]): Promise<ListThread[]> {
    const own = agentThreads.filter((t) => t.thread_id.startsWith(user.prefix)).map(cleanThread);
    let meta: ThreadMeta[] = [];
    try {
        if (await hasThreadTable()) meta = await threadMetaFor(user.id);
    } catch (error) {
        console.error("[analyst] could not read the conversation list:", error);
    }
    return sortThreads(mergeThreads(own, meta)).slice(0, 300);
}
