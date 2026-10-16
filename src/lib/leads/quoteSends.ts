/**
 * Tracker ID 191 (Kartik, 14 Oct) — how each quote was sent, on the lead page.
 * PURE, client-safe: no database import. The reader is ./quoteSendsStore.ts;
 * the rows are quotation_dispatches (E-242: one row per channel per send,
 * sent or failed, with the error).
 *
 *   * The quote card lists each send: "Sent: WhatsApp to 98xxxxx210 on 9 Sep
 *     14:10 · Email to x@y.com on 9 Sep 14:10"; a failed send in red with
 *     its reason.
 *   * The lead timeline already has one "Quote sent to dealer" entry per send
 *     that reached the dealer on some channel (a touchpoint written by
 *     sendQuotation). The failed attempts — including a send where every
 *     channel failed, which writes no touchpoint — are merged in at read time
 *     from the same rows (failedSendTimelineEntries), in red with the reason.
 *   * Not built (decided): delivered / read receipts. A salesperson still
 *     cannot record the dealer's answer for them.
 */
import { maskPhone } from "@/lib/exports/datasets/types";

export type QuoteSend = {
    dispatch_id: string;
    commercial_id: string;
    quote_number: string | null;
    channel: string;
    /** Already masked for WhatsApp (displayRecipient). */
    recipient: string;
    status: "sent" | "failed" | string;
    error: string | null;
    sent_by_name: string | null;
    /** ISO timestamp. */
    sent_at: string;
};

export function channelLabel(channel: string): string {
    if (channel === "whatsapp") return "WhatsApp";
    if (channel === "email") return "Email";
    return channel ? channel[0].toUpperCase() + channel.slice(1) : "—";
}

/** A WhatsApp number is masked like everywhere else ("98xxxxx210"); an email shows whole. */
export function displayRecipient(channel: string, recipient: string | null | undefined): string {
    const r = (recipient ?? "").trim();
    if (!r) return "—";
    if (channel === "whatsapp" || (!r.includes("@") && /\d{6,}/.test(r.replace(/\D/g, "")))) {
        return maskPhone(r) ?? r;
    }
    return r;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Sep 14:10", IST. */
export function formatSendTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const ist = new Date(d.getTime() + 330 * 60_000);
    const hh = String(ist.getUTCHours()).padStart(2, "0");
    const mm = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${hh}:${mm}`;
}

/** "WhatsApp to 98xxxxx210 on 9 Sep 14:10" */
export function sendPhrase(s: Pick<QuoteSend, "channel" | "recipient" | "sent_at">): string {
    return `${channelLabel(s.channel)} to ${s.recipient} on ${formatSendTime(s.sent_at)}`;
}

/** Oldest first — the order the sends happened. */
function chronological(sends: QuoteSend[]): QuoteSend[] {
    return [...sends].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
}

/** The card's "Sent: …" line over the successful sends; null when none went. */
export function sentLine(sends: QuoteSend[]): string | null {
    const ok = chronological(sends.filter((s) => s.status === "sent"));
    return ok.length ? `Sent: ${ok.map(sendPhrase).join(" · ")}` : null;
}

/** The failed sends, each "Email to x@y.com on 9 Sep 14:10 failed — <reason>". */
export function failedLines(sends: QuoteSend[]): string[] {
    return chronological(sends.filter((s) => s.status === "failed")).map(
        (s) => `${sendPhrase(s)} failed — ${s.error?.trim() || "no reason recorded"}`,
    );
}

/** A display-only timeline entry built from a failed send. Never a touchpoint. */
export type QuoteSendTimelineEntry = {
    touchpoint_id: string;
    touchpoint_type: "quote_dispatched";
    performed_by_name: string | null;
    performed_at: string;
    remarks: string;
    display_label: string;
    tone: "failed";
};

export function failedSendTimelineEntries(sends: QuoteSend[]): QuoteSendTimelineEntry[] {
    return sends
        .filter((s) => s.status === "failed")
        .map((s) => ({
            touchpoint_id: `dispatch:${s.dispatch_id}`,
            touchpoint_type: "quote_dispatched" as const,
            performed_by_name: s.sent_by_name,
            performed_at: s.sent_at,
            display_label: "Quote send failed",
            remarks:
                `Quote${s.quote_number ? ` ${s.quote_number}` : ""} not sent on ${channelLabel(s.channel)} to ${s.recipient}` +
                ` — ${s.error?.trim() || "no reason recorded"}`,
            tone: "failed" as const,
        }));
}

/** Merge display entries into a newest-first timeline, keeping it newest first. */
export function mergeNewestFirst<T extends { performed_at: string }>(rows: T[], extra: T[]): T[] {
    if (!extra.length) return rows;
    const t = (v: string) => {
        const n = new Date(v).getTime();
        return Number.isNaN(n) ? 0 : n;
    };
    return [...rows, ...extra].sort((a, b) => t(b.performed_at) - t(a.performed_at));
}

/** The touchpoint remark sendQuotation writes for a send (masked number, channel names). */
export function quoteSentRemark(
    quoteNumber: string | null,
    sent: Array<{ channel: string; recipient: string }>,
    failed: Array<{ channel: string; error?: string | null }>,
): string {
    const ref = quoteNumber ? ` ${quoteNumber}` : "";
    return (
        `Quote${ref} sent on ` +
        sent.map((o) => `${channelLabel(o.channel)} to ${displayRecipient(o.channel, o.recipient)}`).join(" · ") +
        (failed.length
            ? ` — not sent on ${failed
                  .map((o) => `${channelLabel(o.channel)}${o.error ? ` (${o.error})` : ""}`)
                  .join(", ")}`
            : "")
    );
}
