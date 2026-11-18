// Tracker ID 246 — lead page clean-up (ASM and Inside Sales), LAYOUT ONLY.
//
// The words the lead page shows in its header, its "Next step" box and its
// dealer box, worked out from facts the page already has (GET
// /api/inside-sales/lead/[id]). Pure and client-safe: no db, no drizzle.
//
// Nothing here decides who may press a button or what a button saves. The
// Next step box only names which of the page's EXISTING actions fits the stage;
// the page still shows each one only under its own rule (244_246 workflows,
// section 2), so a name here never makes an action reachable that was not.

import { intentBucketOf } from "@/lib/leads/intentBucket";

/** The page's existing actions the Next step box may point at. */
export type NextStepAction =
    | "log_visit"
    /** Opens the same Log visit form (Postponed / Scheduled live there). */
    | "replan_visit"
    | "log_activity"
    | "continue_onboarding"
    | "correct_gstin"
    | "call_now"
    | "mark_won"
    | "visit_not_needed";

export type NextStepTone = "amber" | "rose" | "sky" | "emerald" | "gray";

export type NextStepFacts = {
    /** Which lead page: the ASM page logs visits, the Inside Sales page logs calls. */
    view: "asm" | "isr";
    status: string | null;
    /** Today in IST, YYYY-MM-DD. */
    todayIst: string;
    /** The lead's ONE open booking (ID 247 rule, lib/asm/nextBooking.ts). */
    nextBookingDate: string | null;
    /** True when there is an open booking at all (it may have no date yet). */
    hasOpenBooking: boolean;
    /** > 0 only when the booking's date has passed (server, nextBookingJoin). */
    nextBookingOverdueDays: number | null;
    /** When the booking was made (ISO). */
    nextBookingBookedAt: string | null;
    nextFollowUpAt: string | null;
    /** Newest note written by a person (visit / call / WhatsApp). */
    lastNote: string | null;
    onboarding: {
        applicationId: string | null;
        status: string | null;
        createdAt: string | null;
        agreementLabel: string | null;
        approved: boolean;
        stalled: boolean;
    } | null;
    hasApprovedQuote: boolean;
    hasPendingQuote: boolean;
    lostReasonWords: string | null;
};

export type NextStep = {
    tone: NextStepTone;
    title: string;
    detail: string | null;
    /** A second, red line (e.g. a booked visit never logged on a Won lead). */
    also: string | null;
    /** In order: the first is the main button. */
    actions: NextStepAction[];
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** IST calendar day (YYYY-MM-DD) of an instant or a date string. */
export function istDay(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** "2026-10-30" → "Fri 30 Oct" (a calendar day, no time-zone shift); withWeekday=false → "30 Oct". */
export function dayWords(value: string | null | undefined, withWeekday = true): string {
    const day = istDay(value ?? null);
    if (!day) return "";
    const t = new Date(`${day}T00:00:00Z`);
    const words = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
    return withWeekday ? `${WEEKDAYS[t.getUTCDay()]} ${words}` : words;
}

/** Whole days from `from` (a day) to `to` (a day); null when either is missing. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
    const a = istDay(from ?? null);
    const b = istDay(to ?? null);
    if (!a || !b) return null;
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "APP-552A46CC" — the same short reference the header used (BRD §0.13). */
export function shortAppId(id: string | null | undefined): string {
    return id ? `APP-${id.slice(0, 8).toUpperCase()}` : "—";
}

function words(code: string | null | undefined): string {
    if (!code) return "";
    const s = code.replace(/_/g, " ").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The Next step box: one line saying what to do now, by the lead's stage. */
export function nextStepFor(f: NextStepFacts): NextStep {
    const status = f.status;
    const overdue = f.nextBookingOverdueDays && f.nextBookingOverdueDays > 0 ? f.nextBookingOverdueDays : null;

    if (status === "Lost") {
        return {
            tone: "gray",
            title: f.lostReasonWords ? `Lost: ${f.lostReasonWords}` : "Lost",
            detail: "Reactivate it before working it again.",
            also: null,
            actions: [],
        };
    }
    if (status === "Converted") {
        return {
            tone: "emerald",
            title: "Converted: onboarding approved",
            detail: null,
            also: null,
            actions: [],
        };
    }

    if (status === "Won") {
        const also = overdue && f.nextBookingDate ? `Also: the visit booked for ${dayWords(f.nextBookingDate)} was never logged.` : null;
        const ob = f.onboarding;
        if (!ob || !ob.applicationId) {
            return {
                tone: "amber",
                title: "Won: onboarding not started",
                detail: "No onboarding application is linked to this lead yet.",
                also,
                actions: ["call_now", "correct_gstin"],
            };
        }
        const obStatus = (ob.status ?? "draft").toLowerCase();
        if (obStatus === "draft") {
            const days = daysBetween(ob.createdAt, f.todayIst);
            const age = days == null ? "" : days <= 0 ? ": started today" : `: ${plural(days, "day")}`;
            const parts = [
                `Agreement ${ob.agreementLabel ? ob.agreementLabel.toLowerCase() : "not generated"}`,
                ob.approved ? "approved" : "not approved",
            ];
            if (!f.hasApprovedQuote) parts.push("no approved quote");
            return {
                tone: ob.stalled ? "rose" : "amber",
                title: `Onboarding ${ob.stalled ? "stuck in draft" : "in draft"}${age}`,
                detail: `Application ${shortAppId(ob.applicationId)}${
                    ob.createdAt ? ` started ${dayWords(ob.createdAt, false)}` : ""
                }. ${parts.join(", ")}.`,
                also,
                actions: ["continue_onboarding", "correct_gstin", "call_now"],
            };
        }
        return {
            tone: "sky",
            title: `Onboarding ${words(obStatus).toLowerCase()}: with the Sales Head for review`,
            detail: `Application ${shortAppId(ob.applicationId)}. Nothing to do on the form until the review is back.`,
            also,
            actions: ["call_now", "correct_gstin"],
        };
    }

    // Open stages.
    const visitActions: NextStepAction[] =
        f.view === "asm" ? ["log_visit", "replan_visit", "call_now"] : ["log_activity", "call_now"];
    const note = f.lastNote ? `Last note: "${truncate(f.lastNote, 140)}"` : null;
    const booked = f.nextBookingBookedAt ? `Booked ${dayWords(f.nextBookingBookedAt, false)}.` : null;

    if (f.hasOpenBooking && overdue && f.nextBookingDate) {
        return {
            tone: "amber",
            title: `Visit was due ${dayWords(f.nextBookingDate)}: ${plural(overdue, "day")} overdue`,
            detail: [booked, note].filter(Boolean).join(" ") || null,
            also: null,
            actions: visitActions,
        };
    }
    if (f.hasOpenBooking && f.nextBookingDate) {
        const today = istDay(f.nextBookingDate) === f.todayIst;
        return {
            tone: "sky",
            title: today ? "Visit booked for today" : `Next visit: ${dayWords(f.nextBookingDate)}`,
            detail: [booked, note].filter(Boolean).join(" ") || null,
            also: null,
            actions: f.view === "asm" ? ["log_visit", "call_now"] : ["log_activity", "call_now"],
        };
    }
    if (status === "Transferred_to_ASM" || f.hasOpenBooking) {
        return {
            tone: "amber",
            title: "Awaiting field visit: no date booked yet",
            detail: "Log the visit, or book it with a date.",
            also: null,
            actions:
                f.view === "asm"
                    ? status === "Transferred_to_ASM"
                        ? ["log_visit", "visit_not_needed", "call_now"]
                        : ["log_visit", "call_now"]
                    : ["log_activity", "call_now"],
        };
    }
    if (f.hasPendingQuote) {
        return {
            tone: "sky",
            title: "Quote waiting for CEO approval",
            detail: "It goes to the dealer once the CEO approves it.",
            also: null,
            actions: ["call_now"],
        };
    }
    if (status === "Commercials_Finalised") {
        return {
            tone: "emerald",
            title: "Dealer agreed: mark Won when the dealer confirms",
            detail: f.hasApprovedQuote ? null : "There is no dealer-approved quote yet.",
            also: null,
            actions: ["mark_won", "call_now"],
        };
    }
    if (f.nextFollowUpAt) {
        const late = daysBetween(f.nextFollowUpAt, f.todayIst);
        if (late != null && late >= 0) {
            return {
                tone: late > 0 ? "amber" : "sky",
                title:
                    late > 0
                        ? `Follow-up was due ${dayWords(f.nextFollowUpAt)}: ${plural(late, "day")} overdue`
                        : "Follow-up due today",
                detail: note,
                also: null,
                actions: ["log_activity", "call_now"],
            };
        }
        return {
            tone: "gray",
            title: `Next follow-up: ${dayWords(f.nextFollowUpAt)}`,
            detail: note,
            also: null,
            actions: ["log_activity", "call_now"],
        };
    }
    if (status === "New_Unassigned" || status === "Assigned_Not_Contacted") {
        return {
            tone: "amber",
            title: "First contact: reach the dealer",
            detail: null,
            also: null,
            actions: f.view === "asm" ? ["log_visit", "call_now"] : ["log_activity", "call_now"],
        };
    }
    return {
        tone: "gray",
        title: "No next visit or follow-up planned",
        detail: [note, "Log the next call or visit and set a date."].filter(Boolean).join(" "),
        also: null,
        actions: f.view === "asm" ? ["log_visit", "call_now"] : ["log_activity", "call_now"],
    };
}

function truncate(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// ── Hand-over note in words ─────────────────────────────────────────────────

// The same words the Transfer to ASM form shows for each reason (TransferAsmModal
// REASON_LABEL, wording audit B153), so the hand-over reads as it was picked.
const TRANSFER_REASON_WORDS: Record<string, string> = {
    Commercials_Finalised: "Dealer agreed to quote",
    Site_Visit_Needed: "Site visit needed",
    Negotiation_Beyond_IS_Authority: "Price talks need ASM",
    Demo_Requested: "Demo requested",
    Other: "Other reason",
};
const VISIT_TYPE_WORDS: Record<string, string> = {
    Initial_Visit: "First visit",
    Demo: "Demo visit",
    Negotiation: "Negotiation visit",
    Closing: "Closing visit",
};

/**
 * The asm_transfer touchpoint's remarks (buildTransferRemarks in
 * lib/leads/transferToAsm.ts: "Reason: X; Visit: Y; Date: Z (time)\n\nnotes
 * \n\nPending: …\n\nOut-of-territory: …") in words:
 * "Dealer agreed to quote. First visit booked for Mon 29 Jun." plus the notes.
 * Display only; the stored remarks never change. Text in any other shape is
 * returned as it is.
 */
export function handoverNoteInWords(remarks: string | null | undefined): string {
    if (!remarks) return "";
    const m = /^Reason: ([A-Za-z_]+); Visit: ([A-Za-z_]+)(?:; Date: (\d{4}-\d{2}-\d{2}))?(?: \(([^)]*)\))?/.exec(remarks);
    if (!m) return remarks.trim();
    const [head, reason, visit, date, time] = m;
    const visitWords = VISIT_TYPE_WORDS[visit] ?? words(visit);
    const lines: string[] = [
        `${TRANSFER_REASON_WORDS[reason] ?? words(reason)}. ${visitWords} ${
            date ? `booked for ${dayWords(date)}${time ? ` (${time})` : ""}` : "not dated yet"
        }.`,
    ];
    for (const block of remarks.slice(head.length).split(/\n\n+/)) {
        const b = block.trim();
        if (!b) continue;
        if (b.startsWith("Pending: ")) lines.push(`Still pending: ${b.slice("Pending: ".length)}`);
        else if (b.startsWith("Out-of-territory: ")) lines.push(`Outside the territory because: ${b.slice("Out-of-territory: ".length)}`);
        else lines.push(b);
    }
    return lines.join("\n");
}

// ── Header facts ────────────────────────────────────────────────────────────

/**
 * "Last action" as ID 244's My visits shows it (AsmQueueTable LastActionCell):
 * dl.last_disposition in words · when (dl.last_worked_at), and how long ago.
 */
export function lastActionFact(
    lastAction: string | null | undefined,
    lastActionAt: string | null | undefined,
    now: Date = new Date(),
): { main: string; sub: string | null } {
    if (!lastActionAt) return { main: "No action yet", sub: null };
    const what = lastAction ? lastAction.replace(/_/g, " ") : "Worked";
    return { main: `${what} · ${istDateTimeWords(lastActionAt)}`, sub: agoWords(lastActionAt, now) };
}

/** "3 days ago", "today", "yesterday", "4 months ago" — the My visits wording. */
export function agoWords(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return "";
    const ms = now.getTime() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "";
    const days = Math.floor(ms / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 60) return `${days} days ago`;
    return `${Math.round(days / 30)} months ago`;
}

/** "18 Sept, 11:57 am" in IST. */
export function istDateTimeWords(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const ist = new Date(d.getTime() + 330 * 60_000);
    const h = ist.getUTCHours();
    const mm = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}, ${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "am" : "pm"}`;
}

/** "Next visit" header fact: the one open booking, else nothing booked. */
export function nextVisitFact(f: {
    hasOpenBooking: boolean;
    nextBookingDate: string | null;
    nextBookingOverdueDays: number | null;
    todayIst: string;
}): { main: string; sub: string | null; late: boolean } {
    if (!f.hasOpenBooking) return { main: "None booked", sub: null, late: false };
    if (!f.nextBookingDate) return { main: "Not dated yet", sub: "Booking has no date", late: false };
    const overdue = f.nextBookingOverdueDays && f.nextBookingOverdueDays > 0 ? f.nextBookingOverdueDays : null;
    if (overdue) return { main: dayWords(f.nextBookingDate), sub: `${plural(overdue, "day")} overdue, never logged`, late: true };
    if (istDay(f.nextBookingDate) === f.todayIst) return { main: "Today", sub: dayWords(f.nextBookingDate), late: false };
    return { main: dayWords(f.nextBookingDate), sub: null, late: false };
}

/** "1 visit · 0 calls". */
export function attemptsWords(visits: number, calls: number): string {
    return `${plural(visits, "visit")} · ${plural(calls, "call")}`;
}

/** The header's Payment fact from the newest quote's terms, else the upload's payment intent. */
export function paymentFact(
    cc: { dealer_payment_terms?: string | null; credit_days?: number | null; payment_method?: string | null; customer_finance?: boolean | null } | null,
    preliminary: string | null | undefined,
): { main: string; sub: string | null } {
    if (cc?.dealer_payment_terms === "credit") {
        return { main: cc.credit_days ? `Credit, ${cc.credit_days} days` : "Credit", sub: cc.customer_finance ? "Customer finance too" : "From the quote" };
    }
    if (cc?.dealer_payment_terms === "cash") {
        return { main: "Cash", sub: cc.customer_finance ? "Customer finance too" : "From the quote" };
    }
    if (cc?.payment_method) return { main: words(cc.payment_method), sub: "From the quote" };
    if (preliminary) return { main: words(preliminary), sub: "As given at upload" };
    return { main: "Not asked yet", sub: "Cash or finance?" };
}

type QuoteRow = {
    event_type: string;
    approval_status: string | null;
    dealer_decision: string | null;
    withdrawn_at: string | null;
    version_no: number;
    final_price: string | null;
};

/** The header's Quote fact from the commercials history. */
export function quoteFact(history: readonly QuoteRow[]): { main: string; sub: string | null; warn: boolean } {
    const quotes = history.filter(
        (c) => (c.event_type === "quote_issue" || c.event_type === "quote_revision") && !c.withdrawn_at,
    );
    if (!quotes.length) return { main: "No quote yet", sub: null, warn: false };
    const newest = (rows: QuoteRow[]) => rows.reduce((a, b) => (b.version_no > a.version_no ? b : a));
    const price = (c: QuoteRow) => (c.final_price ? ` · ₹${c.final_price}` : "");
    const dealerYes = quotes.filter((c) => c.dealer_decision === "approved");
    if (dealerYes.length) {
        const q = newest(dealerYes);
        return { main: `Dealer approved v${q.version_no}${price(q)}`, sub: null, warn: false };
    }
    const pending = quotes.filter((c) => c.approval_status === "pending");
    const live = quotes.filter((c) => c.approval_status === "approved");
    if (live.length) {
        const q = newest(live);
        return {
            main: `Sent v${q.version_no}${price(q)}`,
            sub: q.dealer_decision === "declined" ? "Dealer declined" : "No approved quote from the dealer yet",
            warn: q.dealer_decision === "declined",
        };
    }
    if (pending.length) {
        const q = newest(pending);
        return { main: `v${q.version_no} waiting for the CEO`, sub: null, warn: false };
    }
    return { main: "No approved quote", sub: null, warn: true };
}

/** "No AI call yet" / "72 of 100 (Hot)". */
export function aiScoreWords(score: number | null | undefined): string {
    if (score == null) return "No AI call yet";
    // The same Hot / Warm / Cold cut-offs as the IntentBadge and the /leads list.
    const bucket = intentBucketOf(score);
    return `${score} of 100 (${bucket.charAt(0).toUpperCase()}${bucket.slice(1)})`;
}

// ── Dealer box ──────────────────────────────────────────────────────────────

/** The dealer fields the box shows when filled, else lists under "Add missing details". */
export const DEALER_DETAIL_FIELDS = [
    { key: "dealer_name", label: "Dealer name" },
    { key: "shop_name", label: "Shop name" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "language", label: "Language" },
    { key: "business_type", label: "Business type" },
    { key: "source_origin", label: "Found via" },
    { key: "pincode", label: "Pincode" },
    { key: "area", label: "Area" },
    { key: "segments", label: "Segments" },
] as const;

export type DealerDetailKey = (typeof DEALER_DETAIL_FIELDS)[number]["key"];

/** Labels of the dealer fields still empty, in the box's order. */
export function missingDealerDetails(lead: Partial<Record<DealerDetailKey, unknown>>): string[] {
    return DEALER_DETAIL_FIELDS.filter(({ key }) => isBlank(lead[key])).map((f) => f.label);
}

export function isBlank(v: unknown): boolean {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "string") return v.trim() === "";
    return false;
}

// ── Time limits: one plain line ─────────────────────────────────────────────

/**
 * Today's time-limit information (missed limits on record, and any clock past
 * its limit right now) as one plain line. The 246 "time limits box" proposal is
 * NOT approved; this only shortens what the page already shows.
 */
export function timeLimitLine(missed: readonly string[], pastNow: readonly string[]): { late: boolean; text: string } {
    if (!missed.length && !pastNow.length) return { late: false, text: "Time limits: all on time" };
    const parts: string[] = [];
    if (missed.length) parts.push(`${missed.length} missed (${missed.join("; ")})`);
    if (pastNow.length) parts.push(`past now: ${pastNow.join(", ")}`);
    return { late: true, text: `Time limits: ${parts.join(" · ")}` };
}
