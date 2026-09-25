// Tool results + the model's reply → one WhatsApp message, within WhatsApp's
// limits (BRD §9.4, plan §6). Lists and lead cards are built DETERMINISTICALLY
// from tool results — the model's wording never decides what a row says.
//
//   text     ≤ 1,000 chars (WhatsApp allows 4,096; the BRD keeps it short)
//   list     ≤ 10 rows; row title ≤ 24 (shop, truncated); description ≤ 72
//            (status · interest · next date); row id ast:lead:<id>; body ≤ 1,024
//   format   *bold* for a heading only; no markdown tables or links
//
// Truncation never splits a grapheme (emoji, Devanagari conjuncts) and keeps
// BOTH the UTF-16 length and the code-point count within the limit, so the
// result is valid however WhatsApp counts.

import type { LeadSummary, ToolResult } from "@/lib/assistant/types";
import type { ListRow } from "./client";

export const RENDER_LIMITS = {
    text: 1000,
    previewBody: 900,
    listBody: 1024,
    header: 60,
    listButton: 20,
    rowTitle: 24,
    rowDescription: 72,
    rows: 10,
} as const;

export type WaPayload =
    | { kind: "text"; body: string }
    | { kind: "list"; body: string; button: string; header?: string; rows: ListRow[] };

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Fit `s` into `max` characters, ending with "…" when cut. Grapheme-safe. */
export function fit(s: string, max: number): string {
    const text = s.trim();
    if (text.length <= max) return text;
    const room = max - 1; // for "…"
    let out = "";
    for (const { segment } of segmenter.segment(text)) {
        if (out.length + segment.length > room) break;
        out += segment;
    }
    return out.trimEnd() + "…";
}

// Names are fixed here rather than taken from the locale: ICU builds differ
// between machines ("Sep" vs "Sept"), and a reply must read the same everywhere.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_PARTS = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
});

function istParts(d: Date) {
    const p = Object.fromEntries(IST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
    const y = Number(p.year);
    const m = Number(p.month);
    const day = Number(p.day);
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    return { label: `${DAYS[weekday]} ${day} ${MONTHS[m - 1]}`, time: `${p.hour.padStart(2, "0")}:${p.minute.padStart(2, "0")}` };
}

/** "2026-09-26" → "Sat 26 Sep"; a timestamp → "Sat 26 Sep, 11:00" (IST). */
export function fmtDate(v: string | null | undefined): string | null {
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return istParts(new Date(`${v}T12:00:00+05:30`)).label;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const { label, time } = istParts(d);
    return `${label}, ${time}`;
}

function statusLabel(s: string | null): string | null {
    return s ? s.replace(/_/g, " ") : null;
}

/** One list row. The title falls back shop → dealer → id; never empty. */
export function leadRow(lead: LeadSummary): ListRow {
    const title = lead.shop_name?.trim() || lead.dealer_name?.trim() || lead.id;
    const parts = [statusLabel(lead.status), lead.interest, fmtDate(lead.next_date)].filter(Boolean) as string[];
    return {
        id: `ast:lead:${lead.id}`,
        title: fit(title, RENDER_LIMITS.rowTitle),
        ...(parts.length ? { description: fit(parts.join(" · "), RENDER_LIMITS.rowDescription) } : {}),
    };
}

/** Model output hygiene: **bold** → *bold*, no markdown headings / tables / links. */
export function whatsappText(s: string): string {
    return s
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
        .replace(/^\s*\|.*\|\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const LIST_BUTTON = "View leads";

/**
 * The reply for one agent turn. The last list-shaped result (candidates, or a
 * queue/search with 2+ rows) becomes a tappable list; everything else is text.
 */
export function renderTurn(turn: { text: string; results: { tool: string; result: ToolResult }[] }): WaPayload {
    const text = whatsappText(turn.text);
    const listy = [...turn.results]
        .reverse()
        .map((r) => r.result)
        .find(
            (r): r is Extract<ToolResult, { kind: "leads" | "candidates" }> =>
                (r.kind === "candidates" && r.rows.length > 0) || (r.kind === "leads" && r.rows.length >= 2),
        );
    if (listy) {
        const heading = listy.kind === "leads" ? listy.title : "Which one?";
        const fallback =
            listy.kind === "candidates"
                ? listy.question
                : `${listy.rows.length} of ${listy.total}. Tap one for details.`;
        let body = text || fallback;
        if (listy.kind === "leads" && listy.total > listy.rows.length && listy.crm_url) {
            const more = `\n\nAll ${listy.total}: ${listy.crm_url}`;
            if (body.length + more.length <= RENDER_LIMITS.listBody) body += more;
        }
        return {
            kind: "list",
            header: fit(heading, RENDER_LIMITS.header),
            body: fit(body, RENDER_LIMITS.listBody),
            button: LIST_BUTTON,
            rows: listy.rows.slice(0, RENDER_LIMITS.rows).map(leadRow),
        };
    }
    return { kind: "text", body: fit(text || "Done.", RENDER_LIMITS.text) };
}

type Detail = Record<string, unknown> & {
    recent_touchpoints?: Record<string, unknown>[];
    recent_visits?: Record<string, unknown>[];
};

const str = (v: unknown) => (v == null || v === "" ? null : String(v));

/** A lead card for a tapped list row — no model involved. */
export function renderLeadCard(lead: Detail): string {
    const lines: string[] = [];
    const name = str(lead.shop_name) ?? str(lead.dealer_name) ?? str(lead.id) ?? "Lead";
    lines.push(`*${name}*`);
    const who = [str(lead.dealer_name) !== name ? str(lead.dealer_name) : null, str(lead.city)].filter(Boolean).join(" · ");
    if (who) lines.push(who);
    if (lead.phone) lines.push(`Phone: ${lead.phone}`);
    lines.push(
        [
            `Status: ${statusLabel(str(lead.status)) ?? "none"}`,
            lead.interest ? `Interest: ${lead.interest}` : null,
        ].filter(Boolean).join(" · "),
    );
    lines.push(
        lead.owned_by_you ? "Owner: you" : `Owner: ${str(lead.owner_name) ?? "nobody"} (read-only for you)`,
    );
    const next = fmtDate(str(lead.next_follow_up_at));
    if (next) lines.push(`Next follow-up: ${next}`);
    const last = fmtDate(str(lead.last_activity_at));
    if (last) lines.push(`Last activity: ${last}`);

    const tps = (lead.recent_touchpoints ?? []).slice(0, 3);
    if (tps.length) {
        lines.push("", "*Recent*");
        for (const t of tps) {
            const head = [fmtDate(str(t.at)), str(t.type)?.replace(/_/g, " "), str(t.call_status)?.replace(/_/g, " ")]
                .filter(Boolean)
                .join(" · ");
            const remark = str(t.remarks);
            lines.push(remark ? `${head}: ${fit(remark.replace(/\s+/g, " "), 80)}` : head);
        }
    }
    const visits = (lead.recent_visits ?? []).slice(0, 2);
    if (visits.length) {
        lines.push("", "*Visits*");
        for (const v of visits) {
            lines.push(
                [fmtDate(str(v.visited_on) ?? str(v.scheduled_date)), str(v.status), str(v.outcome)?.replace(/_/g, " ")]
                    .filter(Boolean)
                    .join(" · "),
            );
        }
    }
    const url = str(lead.crm_url);
    const tail = url ? `\n\n${url}` : "";
    return fit(lines.join("\n"), RENDER_LIMITS.text - tail.length) + tail;
}
