// D8 — the callback loop's pure parts (no database): the round-robin pick and
// the call brief. src/lib/ai-dialer/callbackLoop.ts does the I/O.

import { PRODUCT_LINE_LABELS, type ProductLine } from "@/lib/ai/scoring/signals";
import { extractDealerLines } from "@/lib/ai/analysis/postCallHelpers";

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
                : `Priya promised a call${input.callbackWhen ? ` (“${input.callbackWhen}”)` : ""} — due ${when}`,
        openQuestions: open,
        secondNumber: second,
        summary: input.summary?.trim() || null,
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
