// PII masking for WhatsApp text. Full values live only in the DB + admin panel;
// the dealer-facing summary shows partly-hidden numbers (design §12, §16).

function maskMiddle(value: string, head: number, tail: number): string {
  const v = (value || "").trim();
  if (v.length <= head + tail) return v;
  return `${v.slice(0, head)}${"*".repeat(Math.max(2, v.length - head - tail))}${v.slice(-tail)}`;
}

/** 27ABCDE1234F1Z5 → 27ABCDE****1Z5 */
export function maskGstin(gstin?: string | null): string {
  if (!gstin) return "—";
  return maskMiddle(gstin, 7, 3);
}

/** ABCDE1234F → ABCDE****F */
export function maskPan(pan?: string | null): string {
  if (!pan) return "—";
  return maskMiddle(pan, 5, 1);
}

/** show only the last 4 digits of an account number */
export function maskAccount(acct?: string | null): string {
  if (!acct) return "—";
  const v = acct.replace(/\s/g, "");
  if (v.length <= 4) return v;
  return `${"X".repeat(v.length - 4)}${v.slice(-4)}`;
}

/** HDFC0001234 → HDFC****234 */
export function maskIfsc(ifsc?: string | null): string {
  if (!ifsc) return "—";
  return maskMiddle(ifsc, 4, 3);
}
