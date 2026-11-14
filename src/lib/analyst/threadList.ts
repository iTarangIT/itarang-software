// AI Analyst — the caller's conversation list (E-381), the pure half. Client-safe.
//
// Two sources: the agent's thread list (tenant-wide, newest 200, already narrowed to the
// caller's prefix) and the CRM's own analyst_threads rows. The CRM row wins on title, pin,
// archive and delete; a CRM row the agent's top 200 no longer carries still shows.

import type { Thread } from "./types";

/** A row of analyst_threads as the list needs it. */
export type ThreadMeta = {
    thread_id: string;
    title: string;
    title_custom: boolean;
    questions: string;
    connection_id: string | null;
    run_count: number;
    last_asked_at: string;
    pinned_at: string | null;
    archived_at: string | null;
    deleted_at: string | null;
    shared: boolean;
};

/** A conversation in the column: the agent's thread plus what the CRM keeps about it. */
export type ListThread = Thread & {
    pinned: boolean;
    archived: boolean;
    shared: boolean;
    title_custom: boolean;
    /** Every question asked in it, newline-joined; for search only. */
    questions?: string;
};

export type ThreadView = "active" | "archived";

/** How many conversations one view shows. */
export const LIST_LIMIT = 100;

function time(at: string | null | undefined): number {
    const t = at ? new Date(at).getTime() : 0;
    return Number.isNaN(t) ? 0 : t;
}

export function mergeThreads(agent: Thread[], meta: ThreadMeta[]): ListThread[] {
    const byId = new Map(meta.map((m) => [m.thread_id, m]));
    const out: ListThread[] = [];
    const seen = new Set<string>();

    for (const t of agent) {
        if (seen.has(t.thread_id)) continue;
        seen.add(t.thread_id);
        const m = byId.get(t.thread_id);
        if (m?.deleted_at) continue;
        out.push({
            ...t,
            title: m?.title_custom ? m.title : t.title,
            // The CRM learns of a question as it is asked; the agent once it is recorded.
            last_run_at: time(m?.last_asked_at) > time(t.last_run_at) ? m!.last_asked_at : t.last_run_at,
            pinned: Boolean(m?.pinned_at),
            archived: Boolean(m?.archived_at),
            shared: Boolean(m?.shared),
            title_custom: Boolean(m?.title_custom),
            questions: m?.questions || t.title,
        });
    }
    for (const m of meta) {
        if (seen.has(m.thread_id) || m.deleted_at) continue;
        seen.add(m.thread_id);
        out.push({
            thread_id: m.thread_id,
            title: m.title,
            run_count: m.run_count,
            last_run_at: m.last_asked_at,
            last_status: "done",
            connection_id: m.connection_id ?? "",
            pinned: Boolean(m.pinned_at),
            archived: Boolean(m.archived_at),
            shared: m.shared,
            title_custom: m.title_custom,
            questions: m.questions || m.title,
        });
    }
    return out;
}

/** Pinned first, then most recently asked. */
export function sortThreads(threads: ListThread[]): ListThread[] {
    return [...threads].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return time(b.last_run_at) - time(a.last_run_at);
    });
}

/** One view of the list, filtered by a search: every word must appear in the title or a question. */
export function viewThreads(threads: ListThread[], view: ThreadView, q = "", limit = LIST_LIMIT): ListThread[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return sortThreads(
        threads.filter((t) => {
            if (t.archived !== (view === "archived")) return false;
            if (!words.length) return true;
            const hay = `${t.title}\n${t.questions ?? ""}`.toLowerCase();
            return words.every((w) => hay.includes(w));
        }),
    ).slice(0, limit);
}

/** A conversation's title as stored: one line, at most 120 characters. */
export function cleanTitle(title: string): string {
    const one = title.replace(/\s+/g, " ").trim();
    return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/** Where a role's AI Analyst lives. */
export function analystHome(role: string): string {
    return role === "sales_head" ? "/sales-head/analyst" : "/ceo/analyst";
}
