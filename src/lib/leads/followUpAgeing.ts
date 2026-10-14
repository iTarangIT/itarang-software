/**
 * Follow-up ageing — how long the lead's CURRENT HOLDER has let it sit, for
 * every "needs attention" / idle / stale check (needs-attention page, the
 * Sales Head's Idle tile, the weekly idle mail, the admin dashboard's stale
 * counts, the inside-sales queue's days column):
 *
 *   1. Follow-up scheduled and still ahead  → not idle. The rep planned the
 *      next touch; the clock sits in the future until that day, so "working
 *      days since" reads 0 and no threshold fires.
 *   2. Follow-up date passed                → ageing counts from that date
 *      (unless the lead was worked after it — the later date wins).
 *   3. No follow-up                         → the later of the last work (call,
 *      visit, status change — E-300 last_worked_at) and the date the current
 *      holder got the lead (assigned_at). A lead handed to a new rep does not
 *      arrive already "idle" with the last owner's days.
 *   4. None of those                        → created_at.
 *
 * A follow-up more than FOLLOW_UP_HORIZON_DAYS ahead is ignored, so a far-off
 * date cannot park a lead out of sight for months.
 *
 * NOT for the admin Leads list's Idle column (src/lib/leads/idle.ts): that one
 * measures how long the LEAD has rotted whoever holds it, so a hand-off must
 * not reset it.
 */
import { sql, type SQL } from "drizzle-orm";

/** A follow-up further ahead than this many days does not hold the clock. */
export const FOLLOW_UP_HORIZON_DAYS = 30;

/**
 * The ageing basis as raw SQL text over the alias `dl` — for builders that
 * compose SQL strings (admin/dashboard.ts). A timestamptz; in the future while
 * a follow-up is pending.
 */
export const FOLLOW_UP_AGEING_BASIS_TEXT = `COALESCE(GREATEST(
    dl.last_worked_at,
    dl.assigned_at,
    CASE WHEN dl.next_follow_up_at <= NOW() + INTERVAL '${FOLLOW_UP_HORIZON_DAYS} days' THEN dl.next_follow_up_at END
), dl.created_at)`;

/** The ageing basis over the alias `dl`, as a drizzle SQL fragment. */
export const FOLLOW_UP_AGEING_BASIS: SQL = sql.raw(FOLLOW_UP_AGEING_BASIS_TEXT);

type Stamp = string | Date | null | undefined;

const ms = (v: Stamp): number | null => {
    if (v == null) return null;
    const t = (v instanceof Date ? v : new Date(v)).getTime();
    return Number.isNaN(t) ? null : t;
};

/** JS twin of FOLLOW_UP_AGEING_BASIS — same rule, for screens that age rows client-side. */
export function followUpAgeingBasis(
    lead: {
        last_worked_at?: Stamp;
        assigned_at?: Stamp;
        next_follow_up_at?: Stamp;
        created_at?: Stamp;
    },
    now: number = Date.now(),
): Date | null {
    const fu = ms(lead.next_follow_up_at);
    const candidates = [
        ms(lead.last_worked_at),
        ms(lead.assigned_at),
        fu != null && fu <= now + FOLLOW_UP_HORIZON_DAYS * 86_400_000 ? fu : null,
    ].filter((t): t is number => t != null);
    const t = candidates.length ? Math.max(...candidates) : ms(lead.created_at);
    return t == null ? null : new Date(t);
}

/** True while a follow-up within the horizon is still ahead — the lead is not idle. */
export function followUpPending(nextFollowUpAt: Stamp, now: number = Date.now()): boolean {
    const fu = ms(nextFollowUpAt);
    return fu != null && fu > now && fu <= now + FOLLOW_UP_HORIZON_DAYS * 86_400_000;
}
