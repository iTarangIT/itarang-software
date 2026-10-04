/**
 * E-322 — quotation terms (tracker ID 73 / handover P1-13). PURE: no database
 * import, so the rules are unit-tested without a connection. The settings read
 * lives in ./quoteTerms.ts.
 *
 * Decisions (Kartik, 26 Sep):
 *   1. Dealer payment terms are a pick list — Cash, or Credit N days. ANY
 *      credit sends the quote to approval; a credit quote is never
 *      auto-approved, however good its price.
 *   2. Warranty and delivery terms are standard: they come from the admin
 *      quotation settings and reps cannot edit them.
 *   3. NBFC finance is for END customers only, not a dealer payment term — it
 *      is its own Yes / No ("customer finance") and feeds onboarding.
 *
 * Built once and used by createCommercial.ts, which serves both the web form
 * and the WhatsApp assistant.
 */
import { z } from "zod";

export const DEALER_PAYMENT_TERMS = ["cash", "credit"] as const;
export type DealerPaymentTerms = (typeof DEALER_PAYMENT_TERMS)[number];

export const MAX_CREDIT_DAYS = 180;

/** The terms a rep may choose. Warranty / delivery are deliberately absent. */
export const QuoteTermsSchema = z
    .object({
        dealer_payment_terms: z.enum(DEALER_PAYMENT_TERMS),
        credit_days: z.number().int().min(1).max(MAX_CREDIT_DAYS).nullable().optional(),
        customer_finance: z.boolean().nullable().optional(),
    })
    .superRefine((v, ctx) => {
        if (v.dealer_payment_terms === "credit" && !v.credit_days) {
            ctx.addIssue({
                code: "custom",
                path: ["credit_days"],
                message: "Credit terms need the number of days (1–180).",
            });
        }
    });
export type QuoteTerms = z.infer<typeof QuoteTermsSchema>;

export interface StandardQuoteTerms {
    warranty: string;
    delivery: string;
}

export const DEFAULT_STANDARD_TERMS: StandardQuoteTerms = {
    warranty: "As per the OEM warranty policy for the product.",
    delivery: "Delivery charges as per actual.",
};

/** Normalised terms as stored on the commercials row. */
export interface ResolvedQuoteTerms {
    dealer_payment_terms: DealerPaymentTerms;
    credit_days: number | null;
    customer_finance: boolean | null;
    /** The text column the document and older readers show. */
    credit_terms: string;
    /** Legacy mirror for onboarding: 'finance' when customer finance is Yes. */
    payment_method: "cash" | "finance" | null;
    warranty_terms: string;
    delivery_terms: string;
}

export function formatCreditTerms(terms: DealerPaymentTerms, days: number | null | undefined): string {
    return terms === "credit" && days ? `Credit — ${days} days` : "Cash";
}

export function resolveQuoteTerms(
    terms: QuoteTerms,
    standard: StandardQuoteTerms,
): ResolvedQuoteTerms {
    const credit = terms.dealer_payment_terms === "credit";
    const days = credit ? (terms.credit_days ?? null) : null;
    const finance = terms.customer_finance ?? null;
    return {
        dealer_payment_terms: terms.dealer_payment_terms,
        credit_days: days,
        customer_finance: finance,
        credit_terms: formatCreditTerms(terms.dealer_payment_terms, days),
        payment_method: finance == null ? null : finance ? "finance" : "cash",
        warranty_terms: standard.warranty,
        delivery_terms: standard.delivery,
    };
}

/**
 * The terms hold: credit always needs a person's approval. Returned alongside
 * the OEM price verdict, never folded into it — the price evaluation keeps
 * meaning exactly what it meant.
 */
export interface TermsHold {
    reason: "credit_terms";
    credit_days: number | null;
}

export function termsHold(terms: Pick<ResolvedQuoteTerms, "dealer_payment_terms" | "credit_days">): TermsHold | null {
    return terms.dealer_payment_terms === "credit"
        ? { reason: "credit_terms", credit_days: terms.credit_days }
        : null;
}

/** Price verdict + terms hold → the row's approval columns. */
export function applyTermsHold(
    priceDecision: { status: "approved" | "pending"; mode: "auto" | "manual" },
    hold: TermsHold | null,
): { status: "approved" | "pending"; mode: "auto" | "manual" } {
    return hold ? { status: "pending", mode: "manual" } : priceDecision;
}

/** Tolerant read of a stored settings value. */
export function mergeStandardTerms(value: unknown): StandardQuoteTerms {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const pick = (x: unknown, d: string) => (typeof x === "string" && x.trim() ? x.trim() : d);
    return {
        warranty: pick(v.warranty, DEFAULT_STANDARD_TERMS.warranty),
        delivery: pick(v.delivery, DEFAULT_STANDARD_TERMS.delivery),
    };
}
