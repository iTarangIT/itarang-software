/**
 * Quote deal card (tracker ID 172, decided by Kartik 10 Oct) — PURE, client-
 * safe: no database import. The store is ./dealCard.ts; the columns are E-336.
 *
 * Three answers on every quote saved from Update commercials, each with the
 * question the rep asks the dealer:
 *   onboarding fee (₹)           "The onboarding fee is ₹X; agreed?"
 *                                0 = waived, and "Why waived?" must be filled
 *   batteries / month            "How many e-rickshaw batteries do you sell a
 *                                month today, and how many will you buy from
 *                                us?" — the second number, after the first order
 *   finance files / month        "Of the customers you sell to each month, how
 *                                many buy on a loan?" — replaces the Customer
 *                                finance Yes / No (customer_finance = files > 0)
 *
 * They lock once the CEO approves the quote or the dealer says yes; after that
 * only the Sales Head changes them. The fee prints on the dealer's quotation;
 * the two estimates are internal and never print.
 */
import { z } from "zod";

export const DEAL_CARD_QUESTIONS = {
    onboarding_fee: "Ask: “The onboarding fee is ₹ ___ ; agreed?”",
    batteries_per_month:
        "Ask: “How many e-rickshaw batteries do you sell a month today, and how many will you buy from us?” Enter the second number.",
    finance_files_per_month: "Ask: “Of the customers you sell to each month, how many buy on a loan?”",
} as const;

/**
 * ID 172 item 5: the Invoice Ledger item-mapping value for the onboarding fee
 * line. Stored as both asset_type and product_id on vyapar_item_map /
 * invoice_line_items (no product behind it); such lines are revenue, never a
 * battery (product_class forced to 'other').
 */
export const ONBOARDING_FEE_ITEM = "onboarding_fee";

/** Who may change a locked deal card. */
export const DEAL_CARD_EDIT_ROLES = ["sales_head"] as const;

/**
 * ID 186 (changed 16 Oct): the card is shown on every quote — new dealer or
 * already onboarded — and is OPTIONAL for these roles: they may leave it
 * empty and still save. A card that is started must be complete (all three
 * answers). Any other role that saves a quote (admin, partner) must fill it.
 */
export const DEAL_CARD_OPTIONAL_ROLES = ["inside_sales_rep", "asm", "sales_head"] as const;

/** Must this role fill the deal card on a quote? Pure. */
export function dealCardRequiredFor(role: string | null | undefined): boolean {
    return !(DEAL_CARD_OPTIONAL_ROLES as readonly string[]).includes(role ?? "");
}

export const DealCardSchema = z
    .object({
        onboarding_fee: z.number().min(0).max(10_000_000),
        fee_waived_reason: z.string().trim().max(500).nullable().optional(),
        batteries_per_month: z.number().int().min(1).max(100_000),
        finance_files_per_month: z.number().int().min(0).max(100_000),
    })
    .superRefine((v, ctx) => {
        if (v.onboarding_fee === 0 && (v.fee_waived_reason?.trim().length ?? 0) < 5) {
            ctx.addIssue({
                code: "custom",
                path: ["fee_waived_reason"],
                message: "The onboarding fee is 0 — say why it is waived (at least 5 characters).",
            });
        }
    });
export type DealCard = z.infer<typeof DealCardSchema>;

/** The card as stored: the waived reason only when the fee is 0. */
export function normaliseDealCard(c: DealCard): DealCard {
    return {
        onboarding_fee: Math.round(c.onboarding_fee * 100) / 100,
        fee_waived_reason: c.onboarding_fee === 0 ? (c.fee_waived_reason?.trim() ?? null) : null,
        batteries_per_month: c.batteries_per_month,
        finance_files_per_month: c.finance_files_per_month,
    };
}

export function sameDealCard(a: DealCard, b: DealCard): boolean {
    const x = normaliseDealCard(a);
    const y = normaliseDealCard(b);
    return (
        x.onboarding_fee === y.onboarding_fee &&
        (x.fee_waived_reason ?? "") === (y.fee_waived_reason ?? "") &&
        x.batteries_per_month === y.batteries_per_month &&
        x.finance_files_per_month === y.finance_files_per_month
    );
}

/**
 * The card as read back from a row (`to_jsonb` fields, so numbers may arrive
 * as strings). Null when the row has no card (older quote, or E-336 missing).
 */
export function parseDealCard(raw: unknown): DealCard | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const fee = r.onboarding_fee == null ? null : Number(r.onboarding_fee);
    const bat = r.expected_batteries_per_month == null ? null : Number(r.expected_batteries_per_month);
    const fin = r.expected_finance_files_per_month == null ? null : Number(r.expected_finance_files_per_month);
    if (fee == null || bat == null || fin == null || [fee, bat, fin].some((n) => !Number.isFinite(n))) return null;
    return {
        onboarding_fee: fee,
        fee_waived_reason: typeof r.fee_waived_reason === "string" ? r.fee_waived_reason : null,
        batteries_per_month: bat,
        finance_files_per_month: fin,
    };
}

/** Is this quote's card locked? CEO approved it (a person, not auto-approval) or the dealer said yes. */
export function dealCardLockedBy(row: {
    approval_status: string | null;
    approved_by: string | null;
    dealer_decision: string | null;
}): "ceo" | "dealer" | null {
    if (row.dealer_decision === "approved") return "dealer";
    if (row.approval_status === "approved" && row.approved_by) return "ceo";
    return null;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** Chips for the CEO panels: [label, value]. Internal screens only. */
export function dealCardChips(c: DealCard | null): Array<[string, string]> {
    if (!c) return [];
    return [
        ["Onboarding fee", c.onboarding_fee > 0 ? inr(c.onboarding_fee) : `Waived${c.fee_waived_reason ? ` — ${c.fee_waived_reason}` : ""}`],
        ["Batteries / month", String(c.batteries_per_month)],
        ["Finance files / month", String(c.finance_files_per_month)],
    ];
}
