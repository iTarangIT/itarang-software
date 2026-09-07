/**
 * The IST calendar, as pure functions.
 *
 * Split out of daily.ts for the same reason scheduling.ts was split out of
 * runner.ts: daily.ts imports `db`, and vitest here is deliberately scoped to
 * no-I/O tests, so anything living beside a database import cannot be unit
 * tested. These three are worth pinning — every "which day did this happen on"
 * decision in the codebase routes through them.
 *
 * daily.ts re-exports all three, so `@/lib/operations/daily` remains their
 * public address and no existing caller changed.
 *
 * IST THROUGHOUT. The boxes run UTC; the team, the standup and every reporting
 * window are Asia/Kolkata. A UTC "day" puts the 00:00–05:29 IST slice — a full
 * Indian working morning — into the previous bucket.
 *
 * Asia/Kolkata is a fixed +05:30 with no DST, but these go through Intl rather
 * than adding 5.5h by hand: the offset arithmetic scattered elsewhere in this
 * repo (buyback/gateway.ts, nbfc/portfolio-summary.ts) works only because that
 * happens to be true today, and reads as a magic number either way.
 */

/** Today's date in IST as YYYY-MM-DD. */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** IST hour and minute, for wall-clock window checks. */
export function istHourMinute(d: Date = new Date()): {
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const [h, m] = parts.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** The IST day before the given instant, as YYYY-MM-DD. */
export function previousIstDate(now: Date = new Date()): string {
  return istDate(new Date(now.getTime() - 86_400_000));
}
