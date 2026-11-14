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
    /** When the conversation started (dates the short title); absent on older readers. */
    created_at?: string | null;
};

/** A conversation in the column: the agent's thread plus what the CRM keeps about it. */
export type ListThread = Thread & {
    pinned: boolean;
    archived: boolean;
    shared: boolean;
    title_custom: boolean;
    /** Every question asked in it, newline-joined; for search only. */
    questions?: string;
    /** The first question as typed, shown on hover when the title is the short one. */
    full_title?: string;
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
            // 251 item 15: a conversation the person has not renamed gets a short title made
            // from its first question ("Biplab visits, 10 Nov"); the question shows on hover.
            title: m?.title_custom ? m.title : shortTitle(t.title, m?.created_at ?? t.last_run_at),
            full_title: t.title,
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
            title: m.title_custom ? m.title : shortTitle(m.title, m.created_at ?? m.last_asked_at),
            full_title: m.title,
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

const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** Question words that say nothing about the subject. */
const FILLER = new Set(
    (
        "how many much what whats which who whom whose when where why is are was were be been do does did done " +
        "can could would should will please pls show me give list tell find get the a an of for to in on at by " +
        "and or my our we i you there their his her it its this that these those made make making number count " +
        "total all any some with from about vs versus as"
    ).split(" "),
);
/** Words for the period: replaced by the conversation's date. */
const PERIOD = new Set(["today", "todays", "now", "yesterday", "yesterdays", "tomorrow"]);

/**
 * 251 item 15: a short title from a question: the subject words (at most four, about 32
 * characters), then the date the conversation started, e.g. "visits did Biplab made today?"
 * on 10 Nov → "Visits Biplab, 10 Nov". Falls back to the cleaned question when nothing is left.
 */
export function shortTitle(question: string, at?: string | null): string {
    const words = question
        .replace(/[?!.,;:"'()[\]{}]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    const kept: string[] = [];
    for (const w of words) {
        const lower = w.toLowerCase();
        if (FILLER.has(lower) || PERIOD.has(lower)) continue;
        if ([...kept, w].join(" ").length > 32) break;
        kept.push(w);
        if (kept.length === 4) break;
    }
    const d = at ? new Date(at) : null;
    const date = d && !Number.isNaN(d.getTime()) ? DAY_MONTH.format(d) : "";
    if (!kept.length) return cleanTitle(question);
    const head = kept.join(" ");
    const subject = head.charAt(0).toUpperCase() + head.slice(1);
    return date ? `${subject}, ${date}` : subject;
}

export type DateGroup = "Today" | "Yesterday" | "Last 7 days" | "Older";

/** 251 item 19: which date group a conversation's last question falls in (IST days). */
export function dateGroup(at: string | null | undefined, now: Date = new Date()): DateGroup {
    const d = at ? new Date(at) : null;
    if (!d || Number.isNaN(d.getTime())) return "Older";
    const day = (x: Date) => Date.parse(`${DAY_KEY.format(x)}T00:00:00Z`);
    const diff = Math.round((day(now) - day(d)) / 86_400_000);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff <= 7) return "Last 7 days";
    return "Older";
}

/** The list cut into date groups, in order, empty groups left out. Input order is kept within a group. */
export function groupByDate(threads: ListThread[], now: Date = new Date()): { label: DateGroup; threads: ListThread[] }[] {
    const order: DateGroup[] = ["Today", "Yesterday", "Last 7 days", "Older"];
    const by = new Map<DateGroup, ListThread[]>(order.map((g) => [g, []]));
    for (const t of threads) by.get(dateGroup(t.last_run_at, now))!.push(t);
    return order.filter((g) => by.get(g)!.length).map((label) => ({ label, threads: by.get(label)! }));
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
