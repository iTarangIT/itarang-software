/**
 * Rupee amounts spelled out in the Indian numbering system.
 *
 * The reference document (docs/ITPI-35 (1).pdf) renders 9,80,295 as
 *
 *   "Indian Rupee Nine Lakh Eighty Thousand Two Hundred Ninety-Five Only"
 *
 * so this reproduces that grouping (crore / lakh / thousand / hundred), that
 * hyphenation ("Ninety-Five", not "Ninety Five"), that prefix and that suffix.
 *
 * Pure and dependency-free — the point is that the hardest-to-eyeball string on
 * the document can be asserted in a unit test.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

/** 0–99. Compound tens are hyphenated, matching the reference document. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t}-${o}` : t;
}

/** 0–999. */
function underThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(" ");
}

/**
 * The integer part, grouped Indian-style.
 *
 * Note the grouping is NOT thousands-all-the-way-up: after the first thousand
 * the groups are two digits each (lakh, crore), which is why this cannot be the
 * usual western triplet loop.
 */
function integerToWords(n: number): string {
  if (n === 0) return "Zero";

  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;

  const parts: string[] = [];
  // Above 99 crore the count of crores is itself grouped Indian-style, so
  // 1,23,45,67,89,012 reads "One Kharab…" in some registers — we stop at crore
  // and let the crore count carry the rest, which is what accounting software
  // (including the reference document's) does.
  if (crore) parts.push(`${integerToWords(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));

  return parts.join(" ");
}

export interface AmountInWordsOptions {
  /** Defaults to "Indian Rupee", as printed on ITPI-35. */
  currencyLabel?: string;
  /** Defaults to "Only". */
  suffix?: string;
}

/**
 * "Indian Rupee Nine Lakh Eighty Thousand Two Hundred Ninety-Five Only"
 *
 * Paise are rendered only when non-zero, because the reference document omits
 * them entirely on a whole-rupee total and printing "and Zero Paise" on every
 * quotation would be noise the business did not ask for.
 */
export function amountInWords(
  amount: number,
  options: AmountInWordsOptions = {},
): string {
  const currencyLabel = options.currencyLabel ?? "Indian Rupee";
  const suffix = options.suffix ?? "Only";

  if (!Number.isFinite(amount)) return "";

  const negative = amount < 0;
  // Round to paise FIRST. Reading the words off a different number than the
  // total prints is the one failure this function must not have, and floating
  // point makes that easy to do by accident.
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;

  const parts = [currencyLabel, integerToWords(rupees)];
  if (paise > 0) parts.push("and", underHundred(paise), "Paise");
  parts.push(suffix);

  const words = parts.join(" ");
  return negative ? `Minus ${words}` : words;
}
