/** Presentation helpers for the Hostinger Ecommerce views. */

import type { EcommercePrice } from "./types";

/**
 * Formats a vendor price for display.
 *
 * The amount is treated as MINOR UNITS (paise for INR). That inference is not
 * yet confirmed with Hostinger — see the Phase 1 notes — so every caller should
 * also surface `rawAmount` rather than presenting this as settled. It matters
 * only cosmetically while the feature is read-only, but must be nailed down
 * before any write path exists.
 */
export function formatPrice(price: EcommercePrice | null): string {
  if (!price || price.amountMinor === null) return "—";
  const divisor = 10 ** price.decimalDigits;
  const major = price.amountMinor / divisor;
  const symbol = price.currencySymbol || price.currencyCode.toUpperCase();
  return `${symbol}${major.toLocaleString("en-IN", {
    minimumFractionDigits: price.decimalDigits,
    maximumFractionDigits: price.decimalDigits,
  })}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Hostinger returns `description` as HTML. The repo has no sanitiser dependency
 * and no existing dangerouslySetInnerHTML usage, so rather than introduce an
 * XSS surface for a read-only admin view, tags are stripped and the text is
 * rendered as paragraphs. Rich rendering can come later with a real sanitiser.
 */
export function htmlToParagraphs(html: string | null): string[] {
  if (!html) return [];
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}
