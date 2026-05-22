/**
 * Shared formatting helpers for the NBFC portal.
 *
 * `inr` / `inrCompact` render rupee amounts; `formatRelativeIST` renders a
 * compact "x min ago" string used by the Command Centre alert feed, falling
 * back to an absolute Asia/Kolkata date for anything older than ~30 days.
 */

export function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
}

/**
 * Compact rupee format — lakh / crore suffixes for large portfolio numbers
 * (e.g. ₹78 L, ₹3.47 Cr). Matches the Command Centre KPI cards.
 */
export function inrCompact(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${inr(n)}`;
}

const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
});

export function formatRelativeIST(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return IST_DATE.format(new Date(iso));
}
