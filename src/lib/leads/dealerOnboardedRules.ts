/**
 * Tracker ID 186 (Kartik, 14 Oct) — is the dealer on this lead already
 * onboarded? PURE, client-safe: no database import. The reader is
 * ./dealerOnboarded.ts.
 *
 * The deal card (onboarding fee, batteries / month, finance files / month —
 * ID 172) is asked only for a dealer who is NOT onboarded yet:
 *   * no approved onboarding — an application linked to the lead (either
 *     direction), one with the lead's phone, or a dealer account made from
 *     the lead; and
 *   * no earlier battery invoice — a non-void invoice (not a credit note) with
 *     a battery line, matched to the lead, its account or one of its GSTINs.
 *     An invoice that carries only the onboarding fee is not a battery invoice.
 * For an onboarded dealer (a reorder) the card is hidden, not stored, and the
 * quotation PDF prints no fee line.
 *
 * When the check could not run (a database error), the dealer is treated as
 * NOT onboarded: the card is asked, exactly as before ID 186.
 */

export type ApprovedOnboardingEvidence = {
    applicationId: string | null;
    company: string | null;
    approvedAt: string | null;
    /** How the onboarding was tied to the lead. */
    via: "lead_link" | "phone" | "account";
};

export type BatteryInvoiceEvidence = {
    invoiceNumber: string | null;
    invoiceDate: string | null;
    /** How the invoice was tied to the lead. */
    via: "lead" | "account" | "gstin";
};

export type DealerOnboardedEvidence = {
    approvedOnboarding: ApprovedOnboardingEvidence | null;
    batteryInvoice: BatteryInvoiceEvidence | null;
    /** The check failed; nothing can be said. */
    checkFailed?: boolean;
};

export type DealerOnboardedVerdict = {
    onboarded: boolean;
    /** Plain-language reason, shown on the lead page and the quote form. */
    reason: string;
    approvedOnboarding: ApprovedOnboardingEvidence | null;
    batteryInvoice: BatteryInvoiceEvidence | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-12" (or an ISO timestamp) → "12 Sep 2026"; null when unreadable. */
export function shortDay(v: string | null | undefined): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? "");
    if (!m) return null;
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/** The decision. Either signal alone makes the dealer onboarded. */
export function decideDealerOnboarded(e: DealerOnboardedEvidence): DealerOnboardedVerdict {
    const base = { approvedOnboarding: e.approvedOnboarding, batteryInvoice: e.batteryInvoice };
    if (e.approvedOnboarding) {
        const a = e.approvedOnboarding;
        const on = shortDay(a.approvedAt);
        const what = a.via === "account" ? "dealer account" : "approved onboarding";
        return {
            ...base,
            onboarded: true,
            reason: `Already onboarded: ${what}${a.company ? ` (${a.company})` : ""}${on ? ` on ${on}` : ""}.`,
        };
    }
    if (e.batteryInvoice) {
        const i = e.batteryInvoice;
        const on = shortDay(i.invoiceDate);
        return {
            ...base,
            onboarded: true,
            reason: `Already onboarded: battery invoice${i.invoiceNumber ? ` ${i.invoiceNumber}` : ""}${on ? ` on ${on}` : ""}.`,
        };
    }
    if (e.checkFailed) {
        return { ...base, onboarded: false, reason: "Could not check whether this dealer is onboarded; the deal card is asked." };
    }
    return { ...base, onboarded: false, reason: "New dealer: no approved onboarding and no battery invoice yet." };
}

/**
 * Does this quote event carry a deal card? Only a quote issue / revision for a
 * dealer who is not onboarded yet. Terms events copy the quote's card, so they
 * carry none for an onboarded dealer either (see createCommercial.ts).
 */
export function dealCardAsked(eventType: string, verdict: Pick<DealerOnboardedVerdict, "onboarded"> | null): boolean {
    if (eventType !== "quote_issue" && eventType !== "quote_revision") return false;
    return !verdict?.onboarded;
}
