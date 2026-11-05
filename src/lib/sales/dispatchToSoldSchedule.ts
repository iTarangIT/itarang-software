// ID 220 — when a dispatched sale is really marked delivered.
//
// The daily job (runDailyDispatchToSold) runs once per IST day from 09:30 and
// moves every sale dispatched more than DISPATCH_TO_SOLD_DAYS before that run.
// So a sale moves at the first 09:30 IST run that is more than the delay after
// its dispatch — usually two mornings after an afternoon dispatch, not "the
// next morning" as Step 5 used to say. Pure; no database.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The job's daily time, 09:30 IST (DISPATCH_TO_SOLD_SLOT). */
export const DISPATCH_TO_SOLD_RUN = { hour: 9, minute: 30 } as const;

/** 09:30 IST on the IST calendar day that `t` falls in. */
function runOnIstDayOf(t: number): number {
  const istMidnight = Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return istMidnight + (DISPATCH_TO_SOLD_RUN.hour * 60 + DISPATCH_TO_SOLD_RUN.minute) * 60_000;
}

/**
 * The 09:30 IST run that will mark this sale delivered: the first run at or
 * after dispatch + `days`. (The job moves sales dispatched before now − days,
 * and its tick lands a few minutes after 09:30, so a boundary sale goes then.)
 */
export function nextAutoDeliveredAt(dispatchedAt: Date, days: number): Date {
  const eligibleAfter = dispatchedAt.getTime() + days * DAY_MS;
  let run = runOnIstDayOf(eligibleAfter);
  if (run < eligibleAfter) run += DAY_MS;
  return new Date(run);
}

/**
 * ID 220 — is a "delivery confirmed" SMS still timely? Only for a sale
 * dispatched within DISPATCH_SOLD_SMS_MAX_DAYS (default 3): weeks after the
 * battery arrived it reads as a mistake. The dealer's notice is not affected.
 */
export function deliveredSmsTimely(
    dispatchedAt: Date | null,
    now: Date,
    maxDays: number = Number(process.env.DISPATCH_SOLD_SMS_MAX_DAYS ?? "3"),
): boolean {
    if (!dispatchedAt) return false;
    const days = Number.isFinite(maxDays) && maxDays > 0 ? maxDays : 3;
    return now.getTime() - dispatchedAt.getTime() <= days * DAY_MS;
}
