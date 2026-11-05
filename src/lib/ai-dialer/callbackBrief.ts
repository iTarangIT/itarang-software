// D8 — the callback loop's pure parts (no database): the round-robin pick and
// the call brief. src/lib/ai-dialer/callbackLoop.ts does the I/O.

import { PRODUCT_LINE_LABELS, type ProductLine } from "@/lib/ai/scoring/signals";
import { extractDealerLines } from "@/lib/ai/analysis/postCallHelpers";
import { workingDaysDueAt } from "@/lib/calendar/officeCalendar";
import type { OfficeHoursArg } from "@/lib/calendar/officeHours";

export type CallbackKind = "sales" | "complaint" | "qualified";

/** Round-robin index — pure, for the test. */
export function pickInTurn(ownerIds: string[], cursor: number): string | null {
    if (ownerIds.length === 0) return null;
    return ownerIds[((cursor % ownerIds.length) + ownerIds.length) % ownerIds.length];
}

// ── The brief ───────────────────────────────────────────────────────────────

export type CallbackBrief = {
    /** The first line: what the call is for. */
    purpose: string;
    shop: string | null;
    city: string | null;
    productLines: string[];
    volume: string | null;
    promise: string;
    openQuestions: string[];
    secondNumber: string | null;
    summary: string | null;
    /** Task 11 — the dealer named no time; the due time is the window opening. */
    timeNotSet?: boolean;
};

const PURPOSE: Record<CallbackKind, string> = {
    sales: "Give the rate and the finance scheme, and agree the next step.",
    qualified:
        "Qualified on an AI call — no time was agreed. Give the rate and the finance scheme, and agree the next step.",
    complaint:
        "Do not pitch. Take the battery serial number and the problem, and tell the dealer iTarang will call back with the service contact.",
};

/** Pure — what the ISR reads before she dials, built from the call. */
export function buildCallbackBrief(input: {
    kind: CallbackKind;
    shop: string | null;
    city: string | null;
    leadPhone: string | null;
    productLines?: readonly string[] | null;
    volumeEvidence?: string | null;
    callbackWhen?: string | null;
    dueAt: Date;
    transcript?: string | null;
    summary?: string | null;
    /** Task 11 — false when the dealer gave no time (callbackDueDetail). */
    timeSet?: boolean;
}): CallbackBrief {
    const when = input.dueAt.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
    const dealer = input.transcript ? extractDealerLines(input.transcript).toLowerCase() : "";
    const open: string[] = [];
    if (/rate|price|daam|दाम|कीमत|भाव|kitne ka|kitna/.test(dealer)) open.push("Price");
    if (/emi|kist|किस्त|finance|loan|लोन/.test(dealer)) open.push("EMI / finance");
    if (/whatsapp|व्हाट्सएप|वॉट्सऐप/.test(dealer)) open.push("WhatsApp details");
    const own = (input.leadPhone ?? "").replace(/\D/g, "").slice(-10);
    const second = (dealer.match(/(?<!\d)[6-9]\d{9}(?!\d)/g) ?? []).find((n) => n !== own) ?? null;
    return {
        purpose: PURPOSE[input.kind],
        shop: input.shop,
        city: input.city,
        productLines: (input.productLines ?? []).map((l) => PRODUCT_LINE_LABELS[l as ProductLine] ?? l),
        volume: input.volumeEvidence?.trim() || null,
        promise:
            input.kind === "qualified"
                ? `No time agreed — due ${when}`
                : input.timeSet === false
                  ? `Time not set — the dealer gave no time${input.callbackWhen ? ` (“${input.callbackWhen}”)` : ""}. Call at ${when} and agree one.`
                  : `Priya promised a call${input.callbackWhen ? ` (“${input.callbackWhen}”)` : ""} — due ${when}`,
        openQuestions: open,
        secondNumber: second,
        summary: input.summary?.trim() || null,
        timeNotSet: input.kind === "qualified" || input.timeSet === false,
    };
}

/** The brief as plain lines (notification, email, NeoDove). */
export function briefLines(b: CallbackBrief): string[] {
    return [
        b.purpose,
        [b.shop, b.city].filter(Boolean).join(", "),
        b.productLines.length ? `Lines: ${b.productLines.join(", ")}` : "",
        b.volume ? `Volume: ${b.volume}` : "",
        b.promise,
        b.openQuestions.length ? `Not answered on the call: ${b.openQuestions.join(", ")}` : "",
        b.secondNumber ? `Second number: ${b.secondNumber}` : "",
        b.summary ? `Call: ${b.summary}` : "",
    ].filter(Boolean);
}

export const KIND_LABEL: Record<CallbackKind, string> = {
    sales: "Callback",
    qualified: "Qualified lead",
    complaint: "Complaint",
};

// ── Expiry (ID 212) ─────────────────────────────────────────────────────────

/** A sales callback nobody worked this many working days after it fell due is closed. */
export const CALLBACK_EXPIRE_WORKING_DAYS = 3;

/**
 * Has an open callback run out? True once `CALLBACK_EXPIRE_WORKING_DAYS`
 * working days (holidays and office hours as loaded) have passed since it fell
 * due. Without it an open callback kept the lead out of AI calling for ever.
 */
export function callbackExpired(
    dueAt: Date,
    now: Date,
    holidays: ReadonlySet<string>,
    hours?: OfficeHoursArg,
): boolean {
    const end = workingDaysDueAt(dueAt, CALLBACK_EXPIRE_WORKING_DAYS, holidays, hours);
    return end != null && end.getTime() <= now.getTime();
}

// ── The ISR metric (task 11) ────────────────────────────────────────────────

/** Window around the due time that counts as "made on time". */
export const ON_TIME_BEFORE_MIN = 15;
export const ON_TIME_AFTER_MIN = 30;

/** On-time share as a percentage, one decimal; null when nothing fell due. */
export function onTimePct(onTime: number, due: number): number | null {
    if (!Number.isFinite(due) || due <= 0) return null;
    return Math.round((Math.max(0, Math.min(onTime, due)) / due) * 1000) / 10;
}
