// The lead's LIVE quote, picked from its commercials history on the client.
//
// Client-safe (no db import). The rule is LIVE_QUOTE_VERSION in
// src/lib/leads/quoteSendGate.ts, restated for rows already in the browser: a
// quote (not a brochure / terms row), approved, not withdrawn — and of those,
// the newest. Keep the two in step: this decides where the lead screen puts
// Send / Withdraw, that decides whether the server accepts them.
//
// Why the screen needs it (tracker ID 60 / 61): the "current version" of a
// lead's commercials is simply its newest ROW, and a newer row is often not a
// quote at all — final terms, a terms update, a brochure — or is a revision
// still waiting for the CEO. The quote the dealer can answer is then an older
// row, and wiring Send / Withdraw to the newest row alone left it with neither.

export type QuoteVersionLike = {
    version_no: number;
    event_type: string;
    approval_status: string | null;
    withdrawn_at: string | null;
};

export function isLiveQuoteVersion(row: QuoteVersionLike): boolean {
    return (
        (row.event_type === "quote_issue" || row.event_type === "quote_revision") &&
        row.approval_status === "approved" &&
        !row.withdrawn_at
    );
}

/**
 * A quote still waiting for the CEO and not withdrawn (ID 78): nothing a dealer
 * can answer, but something the rep can still withdraw — it then leaves the
 * CEO's queue.
 */
export function isPendingQuoteVersion(row: QuoteVersionLike): boolean {
    return (
        (row.event_type === "quote_issue" || row.event_type === "quote_revision") &&
        row.approval_status === "pending" &&
        !row.withdrawn_at
    );
}

/** The newest quote version still waiting for the CEO, or null. */
export function pickPendingQuote<T extends QuoteVersionLike>(history: readonly T[]): T | null {
    let pending: T | null = null;
    for (const row of history) {
        if (isPendingQuoteVersion(row) && (!pending || row.version_no > pending.version_no)) pending = row;
    }
    return pending;
}

/** The newest live quote version, or null when the lead has none. */
export function pickLiveQuote<T extends QuoteVersionLike>(history: readonly T[]): T | null {
    let live: T | null = null;
    for (const row of history) {
        if (isLiveQuoteVersion(row) && (!live || row.version_no > live.version_no)) live = row;
    }
    return live;
}
