// Online store → CRM "Buy on finance" intake (Store R-15, decision D-12).
//
// shop.itarang.com posts every "Buy on finance" enquiry to
// POST /api/integrations/online-store/finance-lead. This module holds the
// wire contract the store is built against — the shared-key check and the
// body schema — plus the lead remark text. The database side is
// ./finance-lead.ts.
//
//   ONLINE_STORE_API_KEY  shared secret (>= 32 chars, one per environment),
//                         sent by the store as `x-store-key`. Same value as the
//                         store's CRM key setting. Blank = the route answers 503.
//
// Pure: no DB. Imported by the route and the tests. Server-only — the key
// must never reach a browser.

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const STORE_KEY_HEADER = "x-store-key";

const MIN_KEY_LENGTH = 32;

/** The configured key, or null when unset or too short to be a real one. */
export function getOnlineStoreKey(): string | null {
    const key = process.env.ONLINE_STORE_API_KEY?.trim() || null;
    if (key && key.length < MIN_KEY_LENGTH) {
        // A short key is a misconfiguration, not a weaker mode: treat it as
        // unset so nothing is accepted with it (same rule as ECOFY_SYNC_SECRET).
        console.error(`[OnlineStore] ONLINE_STORE_API_KEY is shorter than ${MIN_KEY_LENGTH} chars — ignored`);
        return null;
    }
    return key;
}

/**
 * Constant-time check of the key the store sent. Both sides are hashed first
 * so the comparison takes the same time whatever the length of the guess.
 */
export function verifyStoreKey(expected: string, sent: string | null | undefined): boolean {
    const got = (sent ?? "").trim();
    if (!expected || !got) return false;
    const a = createHash("sha256").update(got, "utf8").digest();
    const b = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(a, b);
}

/** Optional text field: absent, null or blank all mean "not sent". */
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .nullish()
        .transform((v) => (v ? v : null));

export const financeLeadSchema = z.object({
    storeRef: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    mobile: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, "10-digit Indian mobile, no +91"),
    pincode: z
        .string()
        .trim()
        .regex(/^[1-9]\d{5}$/, "6-digit pincode"),
    productSku: optionalText(100),
    productTitle: optionalText(300),
    productUrl: optionalText(2000),
    pricePaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish().transform((v) => v ?? null),
    page: z.enum(["product", "checkout"]),
});

export type FinanceLeadInput = z.infer<typeof financeLeadSchema>;

const rupees = (paise: number) =>
    `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * leads.remarks for the new lead — what the customer was looking at, in one
 * line the caller reads before ringing them. leads has no pincode column, so
 * it goes here too (and on the online_store_finance_leads row).
 */
export function financeLeadRemarks(input: FinanceLeadInput): string {
    const where = input.page === "checkout" ? "checkout" : "product page";
    const product = [
        input.productTitle,
        input.productSku ? `(SKU ${input.productSku})` : null,
        input.pricePaise != null ? rupees(input.pricePaise) : null,
    ]
        .filter(Boolean)
        .join(" ");
    return [
        `Online store — Buy on finance (${where}).`,
        product ? `Product: ${product}.` : null,
        `Pincode ${input.pincode}.`,
        input.productUrl ? `Link: ${input.productUrl}` : null,
        `Store ref ${input.storeRef}.`,
    ]
        .filter(Boolean)
        .join(" ");
}
