/** IST calendar helpers for the daily brief (E-306). Pure. */

const IST = "Asia/Kolkata";

/** yyyy-mm-dd of `d` in IST. */
export function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 0-23 hour of `d` in IST. */
export function istHour(d: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", hour12: false }).format(d);
  return Number(h) % 24;
}

/** "Wed, 24 Sep" style label for a yyyy-mm-dd. */
export function istDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(dt);
}
