/**
 * IST wall-clock scheduling for the Fleet Monitor morning send.
 *
 * Pure, so the awkward cases (the IST date rolling 5h30 before the UTC one, a
 * box that was restarting when the clock struck) are unit-testable without a
 * timer. See src/lib/monitor/__tests__/schedule.test.ts.
 *
 * The rule, copied from src/lib/digests/schedule.ts because it is the one that
 * survives a PM2 restart: a slot is due from its configured IST time until the
 * END of that IST day. The window is generous on purpose — it is the claim in
 * digest_runs, not the window, that stops a due slot being sent twice.
 */

/** Whole hours and minutes of IST wall-clock. Not a cron string. */
export type Slot = { hour: number; minute: number };

export type SlotState = {
    /** The IST calendar day this instant falls in, YYYY-MM-DD. */
    istDate: string;
    /** Minutes since IST midnight, for logging and tests. */
    istMinutes: number;
    due: boolean;
};

/**
 * `en-CA` because it formats dates as YYYY-MM-DD, which is both the shape
 * digest_runs.digest_date wants and sortable as a string.
 */
const IST = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

export function istSlotState(now: Date, slot: Slot): SlotState {
    const parts = IST.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";

    const istDate = `${get("year")}-${get("month")}-${get("day")}`;
    // Intl renders midnight as "24" under hour12:false in some runtimes; treat
    // it as hour 0 of the date it already reported, rather than 24:xx.
    const hour = Number(get("hour")) % 24;
    const istMinutes = hour * 60 + Number(get("minute"));

    return {
        istDate,
        istMinutes,
        due: istMinutes >= slot.hour * 60 + slot.minute,
    };
}
