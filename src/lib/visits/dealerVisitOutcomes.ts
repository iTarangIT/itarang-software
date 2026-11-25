/**
 * Tracker ID 241 (agreed 11 Nov, Kartik) — rules for visits on an EXISTING dealer
 * (My dealers > Log visit) and the dealer page. Pure: no database, no React, so the
 * API, the form and the page share one copy and Vitest covers it.
 *
 *   241-2  dealer outcomes, an amount the dealer mentioned ("reported by the rep",
 *          NEVER revenue), and a next visit date — required unless "No follow-up".
 *   241-1  the dealer page's Next step box and its one history list.
 */
import { ACCOUNT_BUCKET_LABELS, type AccountBucket } from "@/lib/dealers/accountHealthRules";

export const DEALER_VISIT_OUTCOMES = [
    "order_taken",
    "payment_collected",
    "stock_check",
    "complaint_service",
    "scheme_explained",
    "dealer_not_present",
    "other",
] as const;
export type DealerVisitOutcome = (typeof DEALER_VISIT_OUTCOMES)[number];

export const DEALER_VISIT_OUTCOME_LABELS: Record<DealerVisitOutcome, string> = {
    order_taken: "Order taken",
    payment_collected: "Payment collected",
    stock_check: "Stock check",
    complaint_service: "Complaint / service",
    scheme_explained: "Scheme explained",
    dealer_not_present: "Dealer not present",
    other: "Other",
};

/** Outcomes where the dealer may have mentioned an amount (order value, payment). */
export const AMOUNT_OUTCOMES: readonly DealerVisitOutcome[] = ["order_taken", "payment_collected"];

/**
 * The lead-style outcome stored in lead_visits.visit_outcome next to the dealer
 * outcome, so the Sales Head's visit numbers (which read visit_outcome) keep
 * counting a dealer visit the way they did before 241-2.
 */
export function leadOutcomeFor(o: DealerVisitOutcome): "productive" | "dealer_not_present" | "other" {
    if (o === "dealer_not_present") return "dealer_not_present";
    if (o === "other") return "other";
    return "productive";
}

export function isDealerVisitOutcome(v: unknown): v is DealerVisitOutcome {
    return typeof v === "string" && (DEALER_VISIT_OUTCOMES as readonly string[]).includes(v);
}

const MAX_DAYS_AHEAD = 90;
const DAY_MS = 86_400_000;
const dayNum = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);

export type DealerVisitInput = {
    dealerOutcome: string | null | undefined;
    reportedAmount: number | null | undefined;
    nextVisitDate: string | null | undefined;
    noFollowUp: boolean | null | undefined;
};

/** The first thing wrong with a dealer visit's 241-2 fields, in words; null when fine. */
export function dealerVisitProblem(v: DealerVisitInput, todayIst: string): string | null {
    if (!isDealerVisitOutcome(v.dealerOutcome)) return "Pick the visit outcome.";
    if (v.reportedAmount != null) {
        if (!Number.isFinite(v.reportedAmount) || v.reportedAmount < 0) return "The amount must be a positive number.";
        if (v.reportedAmount > 1e10) return "The amount is too large.";
    }
    if (v.noFollowUp) {
        if (v.nextVisitDate) return "Choose a next visit date or No follow-up needed, not both.";
        return null;
    }
    if (!v.nextVisitDate) return "Pick the next visit date, or tick No follow-up needed.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.nextVisitDate) || Number.isNaN(dayNum(v.nextVisitDate))) {
        return "The next visit date is not a valid date.";
    }
    const ahead = (dayNum(v.nextVisitDate) - dayNum(todayIst)) / DAY_MS;
    if (ahead < 1) return "The next visit must be after today.";
    if (ahead > MAX_DAYS_AHEAD) return `The next visit must be within ${MAX_DAYS_AHEAD} days.`;
    return null;
}

// ─────────────────────────────── 241-1 Next step box ───────────────────────────────

export type NextStepTone = "red" | "orange" | "amber" | "sky" | "green" | "grey";

export type DealerNextStep = { tone: NextStepTone; title: string; detail: string };

export type DealerFacts = {
    bucket: AccountBucket;
    daysSinceLastOrder: number | null;
    daysSinceConversion: number | null;
    orders: number;
    /** The open booked dealer visit (IST date), if any. */
    nextVisitDate: string | null;
    /** An "Order placed" claim waiting for its invoice. */
    pendingOrder: boolean;
};

const shortDay = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What the rep should do next with this dealer, from facts only (invoices, visits,
 * the booked visit) — the rep never sets a dealer status by hand (241 option C).
 * An overdue booked visit comes first; otherwise the reorder stage speaks.
 */
export function dealerNextStep(f: DealerFacts, todayIst: string): DealerNextStep {
    if (f.nextVisitDate) {
        const late = Math.round((dayNum(todayIst) - dayNum(f.nextVisitDate)) / DAY_MS);
        if (late > 0) {
            return {
                tone: "red",
                title: `Visit was due ${shortDay(f.nextVisitDate)}: ${plural(late, "day")} overdue`,
                detail: "Log the visit, or book a new date when you log it.",
            };
        }
        if (late === 0) {
            return { tone: "amber", title: "Visit due today", detail: "Log the visit at the shop with the photo and location." };
        }
    }
    if (f.pendingOrder) {
        return {
            tone: "sky",
            title: "Order recorded: waiting for its invoice",
            detail: "The order counts as the latest for 15 days; it stops counting if no invoice comes in that time.",
        };
    }
    const since = f.daysSinceLastOrder;
    const onlyOne = f.orders === 1 ? "the only invoice" : "the last invoice";
    switch (f.bucket) {
        case "red":
            return {
                tone: "red",
                title: `Billing must happen: ${plural(since ?? 0, "day")} since ${onlyOne}`,
                detail: "Red = 46 to 60 days since the last order. After 60 days the dealer turns Dormant.",
            };
        case "orange":
            return {
                tone: "orange",
                title: `Pitch the next order: ${plural(since ?? 0, "day")} since ${onlyOne}`,
                detail: "Orange = 31 to 45 days since the last order. At 46 days it turns Red: billing must happen.",
            };
        case "dormant":
            return {
                tone: "grey",
                title: `Win the dealer back: ${plural(since ?? 0, "day")} since ${onlyOne}`,
                detail: "Dormant = more than 60 days since the last order.",
            };
        case "never_ordered":
            return {
                tone: "amber",
                title: `Get the first order: ${plural(f.daysSinceConversion ?? 0, "day")} since becoming a dealer`,
                detail: "Never ordered = more than 30 days since conversion with no invoice.",
            };
        case "not_ordered_yet":
            return {
                tone: "sky",
                title: "Get the first order",
                detail: "New dealer: up to 30 days since conversion, no invoice yet.",
            };
        case "cooling":
            return {
                tone: "sky",
                title: `Keep in touch: ${plural(since ?? 0, "day")} since ${onlyOne}`,
                detail: "Cooling = 21 to 30 days since the last order. At 31 days it turns Orange: pitch now.",
            };
        case "closed":
            return { tone: "grey", title: "Closed dealer", detail: "Only Admin closes or reopens a dealer." };
        case "active":
        default:
            return {
                tone: "green",
                title: f.nextVisitDate ? `Next visit ${shortDay(f.nextVisitDate)}` : "Ordering well: book the next visit",
                detail: "Active = an order in the last 20 days.",
            };
    }
}

/** The stage chip text without its day range: "Orange — pitch now (31–45 d)" → "Orange, pitch now". */
export function bucketChip(b: AccountBucket): string {
    return ACCOUNT_BUCKET_LABELS[b].split(" (")[0].replace(" — ", ", ");
}

// ─────────────────────────────── 241-1 one history ───────────────────────────────

export type HistoryKind = "visit" | "booked" | "quote" | "order" | "invoice" | "joined";

export type HistoryItem = {
    kind: HistoryKind;
    /** ISO date or timestamp; the list is newest first on this. */
    at: string;
    title: string;
    detail: string | null;
    by?: string | null;
    /** Visit photo, through the checked file route. */
    photo?: string | null;
    verified?: boolean | null;
    /** "reported by the rep" amount on a visit — never revenue. */
    reportedAmount?: number | null;
};

/** Newest first; a booked (future) visit sits above everything; same moment keeps input order. */
export function sortHistory(items: HistoryItem[]): HistoryItem[] {
    return items
        .map((it, i) => ({ it, i }))
        .sort((a, b) => {
            const ab = a.it.kind === "booked" ? 1 : 0;
            const bb = b.it.kind === "booked" ? 1 : 0;
            if (ab !== bb) return bb - ab;
            const d = Date.parse(b.it.at) - Date.parse(a.it.at);
            return d !== 0 && !Number.isNaN(d) ? d : a.i - b.i;
        })
        .map((x) => x.it);
}

// 25 Nov item 8: recorded orders get their own filter (they used to sit under Invoices).
export const HISTORY_FILTERS = ["all", "visits", "quotes", "orders", "invoices"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export function historyMatches(item: HistoryItem, f: HistoryFilter): boolean {
    if (f === "all") return true;
    if (f === "visits") return item.kind === "visit" || item.kind === "booked";
    if (f === "quotes") return item.kind === "quote";
    if (f === "orders") return item.kind === "order";
    return item.kind === "invoice";
}
