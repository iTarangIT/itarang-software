// Compact INR display for dashboards — turns a rupee amount into a short,
// scannable string using the Indian numbering system (K / Lakh / Crore).
//
// NOTE: this operates on RUPEES. It is intentionally separate from
// `src/lib/currency.ts`, which formats AI-call costs stored as paise.
export function formatINRCompact(rupees: number, decimals = 2): string {
  const v = Number(rupees) || 0;
  const abs = Math.abs(v);
  // Truncate toward zero (never round up) so the compact figure never
  // overstates the exact value — e.g. ₹7,52,694 reads "₹7.52L", not "₹7.53L".
  const truncTo = (n: number, d: number) => {
    const f = 10 ** d;
    return Math.trunc(n * f) / f;
  };
  if (abs >= 1_00_00_000)
    return `₹${truncTo(v / 1_00_00_000, decimals).toFixed(decimals)}Cr`;
  if (abs >= 1_00_000)
    return `₹${truncTo(v / 1_00_000, decimals).toFixed(decimals)}L`;
  if (abs >= 1_000) return `₹${truncTo(v / 1_000, 0).toFixed(0)}K`;
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// Exact rupee value with Indian digit grouping and paise — matches the raw DB
// figure (e.g. "₹1,95,16,513.60"). Used under the compact headline so the
// number is both scannable and precise.
export function formatINRExact(rupees: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(rupees) || 0);
}
