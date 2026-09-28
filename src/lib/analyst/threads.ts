// Data Analyst agent — the thread column's list.

import type { Thread } from "./types";

/** How many of the caller's conversations the column shows. */
export const THREAD_LIMIT = 30;

/**
 * The caller's own threads out of the shared tenant's list.
 *
 * The agent returns at most 200 threads across every CRM user, so a user whose conversations
 * are all older than the 200 most recent tenant-wide sees none. Fine at CEO + sales-head
 * volume; a per-user filter on the agent side is the fix if that ever bites.
 */
export function ownThreads(user: { prefix: string }, threads: Thread[]): Thread[] {
  return threads.filter((t) => t.thread_id.startsWith(user.prefix)).slice(0, THREAD_LIMIT);
}

/** The list as it will look once the agent has recorded the question just asked. */
export function withAskedThread(
  threads: Thread[],
  asked: { threadId: string; question: string; connectionId: string; at: string },
): Thread[] {
  const existing = threads.find((t) => t.thread_id === asked.threadId);
  const rest = threads.filter((t) => t.thread_id !== asked.threadId);
  const updated: Thread = existing
    ? { ...existing, run_count: existing.run_count + 1, last_run_at: asked.at, last_status: "running" }
    : {
        thread_id: asked.threadId,
        // The agent titles a thread by its first question too, so the row does not rename.
        title: asked.question,
        run_count: 1,
        last_run_at: asked.at,
        last_status: "running",
        connection_id: asked.connectionId,
      };
  return [updated, ...rest];
}
