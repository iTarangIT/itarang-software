/**
 * The dealer's margin, as typed into a WhatsApp chat.
 *
 * PURE and DB-free, for the same reason ./stock-rows is: what this file gets
 * wrong is a PRICE, and a wrong price is not a rendering bug — it is an invoice
 * the customer approved over OTP. So the parsing and the arithmetic are unit
 * tested, which means no `db` import here.
 *
 * WHY IT DELEGATES THE ARITHMETIC.
 *
 * `resolveMargin` in the dealer web cart is already the definition of what a
 * percentage margin means in this product (`Math.round(netSubtotal * p / 100)`,
 * rounded to whole rupees). The chat and the Step-5 screen write the SAME
 * `product_selections` row, and a lead whose price depends on which surface the
 * dealer used would be a genuinely nasty bug to find. So the chat reuses that
 * function rather than restating the formula — the cart module says in its own
 * header that it is React-free precisely so a server surface can.
 *
 * WHAT IS NEW HERE is only the part the web has and chat does not: a text box
 * has a keyboard and a numeric input, a WhatsApp message has neither. Everything
 * below exists to turn "7.5%", " ₹ 3,000 " or "3000 rs" into a number, and to
 * refuse the things that are not one.
 */

import {
  finalPriceOf,
  MARGIN_GST_PCT,
  marginGst,
  resolveMargin,
} from "@/components/dealer-portal/lead-wizard/product-cart/pricing";
import type { MarginMode } from "@/components/dealer-portal/lead-wizard/product-cart/types";

export type { MarginMode };
// Re-exported so the chat flow and the web cart share ONE definition of
// "GST on margin" and of the customer-facing total.
export { finalPriceOf, MARGIN_GST_PCT, marginGst };

/**
 * Caps. Both are deliberately far above any real margin — they are typo guards,
 * not policy.
 *
 * The percent one is the load-bearing half: a dealer who means "₹3000" and taps
 * "Percentage" would otherwise add 3000% to the price and be shown a total in
 * the crores. Refusing it puts them back on the mode buttons, which is the fix.
 */
export const MAX_MARGIN_PERCENT = 100;
export const MAX_MARGIN_RUPEES = 10_00_000;

export type MarginParse =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Read a margin out of a chat message.
 *
 * Accepts the decorations people actually type — a rupee sign, a percent sign,
 * Indian digit grouping, a trailing "rs"/"rupees"/"inr" — and nothing else. A
 * message with any OTHER letter in it is refused rather than salvaged: "about
 * 5k" parsing as 5 is worse than asking again.
 */
export function parseMarginInput(
  mode: MarginMode,
  raw: string | null | undefined,
): MarginParse {
  const example = mode === "percent" ? "*5*  or  *7.5*" : "*3000*";
  const reject = (why: string): MarginParse => ({
    ok: false,
    error: `${why}\n\nType just the figure — ${example}.`,
  });

  const text = (raw ?? "")
    .trim()
    .toLowerCase()
    // The decorations, then the units. Order matters: "rs" must go before the
    // letter check below, and "rupees" before "rs" would leave "upees".
    .replace(/[₹%,\s]/g, "")
    .replace(/(rupees|rupee|inr|rs)$/, "");

  if (!text) return reject("I didn't catch a number there.");
  // Number("") is 0 and Number("0x1f") is 31 — neither is a margin a dealer
  // typed, so the shape is checked before the value.
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return reject("That doesn't look like a number.");
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return reject("That doesn't look like a number.");

  if (mode === "percent") {
    if (n > MAX_MARGIN_PERCENT) {
      return reject(
        `${trimNum(n)}% is more than the whole price — did you mean ₹${trimNum(n)}?`,
      );
    }
    // Two decimals is the most a percentage can carry and still round to a
    // whole rupee on any price this business sells.
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  if (n > MAX_MARGIN_RUPEES) {
    return reject(`₹${n.toLocaleString("en-IN")} is higher than we can accept.`);
  }
  return { ok: true, value: Math.round(n) };
}

/**
 * The margin in rupees, for a given mode/value and inventory subtotal.
 *
 * `netSubtotal` is the GST-inclusive item total — the same base the web cart
 * uses, so a 5% margin means the same number on both surfaces.
 */
export function marginAmount(
  mode: MarginMode,
  value: number,
  netSubtotal: number,
): number {
  const s = String(value);
  return resolveMargin(mode, s, s, netSubtotal);
}

/** "5" not "5.00"; "7.5" not "7.50". For echoing a percentage back. */
export function trimNum(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** How the dealer's own margin line reads. Never shown to a customer. */
export function marginLabel(mode: MarginMode, value: number): string {
  return mode === "percent" ? `${trimNum(value)}%` : `₹${value.toLocaleString("en-IN")}`;
}
