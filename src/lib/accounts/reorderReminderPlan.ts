/**
 * Tracker ID 5 — the reorder reminders, as pure rules (no I/O, unit-tested).
 * The sending half is ./reorderReminders.ts.
 *
 * Agreed with the business (P1 sheet, ID 5 item 4): reminders differ by bucket,
 * not a flat 10 days.
 *   Orange (31–45 d)  every day, to the dealer's owner: "pitch now".
 *   Dormant (60+ d)   once a month, a win-back list: each owner gets their own
 *                     dormant dealers, the Sales Head gets all of them.
 *   Dormant → CEO     the CEO is alerted when a dealer turns Dormant (once per
 *                     dormancy: a new invoice and a later lapse alert again).
 *   Active, Cooling   no reminder — visible on the list only.
 * Red, Closed and the never-ordered buckets get no reminder. A dealer with an
 * open "Order placed" claim is already out of Orange / Dormant (the claim pauses
 * its ageing), so it is never nudged.
 *
 * A dealer nobody owns (or whose owner left) goes to the Sales Head, so it is
 * assigned rather than forgotten.
 */
import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import { isTestLogin } from "@/lib/users/testLogin";

export type ReminderUser = { id: string; email: string | null; name: string | null; role: string; is_active: boolean };

export type ReminderMail = {
    /** account_reminder_log.recipient — the user id. */
    recipientId: string;
    email: string;
    name: string | null;
    dealers: DealerHealthRow[];
    /** True when the list holds dealers with no (active) owner. */
    includesUnowned: boolean;
};

/** IST hour from which the day's reminders go out (after the morning digests). */
export const REMINDER_HOUR_IST = 10;

const usable = (u: ReminderUser | undefined): u is ReminderUser & { email: string } =>
    !!u && u.is_active && !!u.email && u.email.includes("@") && !isTestLogin(u.email);

function byOwner(
    rows: DealerHealthRow[],
    users: Map<string, ReminderUser>,
): { owned: Map<string, DealerHealthRow[]>; unowned: DealerHealthRow[] } {
    const owned = new Map<string, DealerHealthRow[]>();
    const unowned: DealerHealthRow[] = [];
    for (const r of rows) {
        const owner = r.owner_id ? users.get(r.owner_id) : undefined;
        if (!usable(owner)) {
            unowned.push(r);
            continue;
        }
        owned.set(owner.id, [...(owned.get(owner.id) ?? []), r]);
    }
    return { owned, unowned };
}

const salesHeads = (users: ReminderUser[]) =>
    users.filter((u): u is ReminderUser & { email: string } => usable(u) && u.role === "sales_head");

/** Most overdue first. */
const sortOverdue = (rows: DealerHealthRow[]) =>
    [...rows].sort(
        (a, b) => (b.days_since_last_order ?? 0) - (a.days_since_last_order ?? 0) || a.dealer.localeCompare(b.dealer),
    );

/**
 * Daily Orange nudge: one mail per owner with their Orange dealers; the Orange
 * dealers nobody owns go to every Sales Head (added to their own list).
 */
export function planOrangeNudges(rows: DealerHealthRow[], users: ReminderUser[]): ReminderMail[] {
    const userMap = new Map(users.map((u) => [u.id, u]));
    const { owned, unowned } = byOwner(rows.filter((r) => r.bucket === "orange"), userMap);
    const mails = new Map<string, ReminderMail>();
    for (const [id, list] of owned) {
        const u = userMap.get(id)!;
        mails.set(id, { recipientId: id, email: u.email!, name: u.name, dealers: list, includesUnowned: false });
    }
    if (unowned.length > 0) {
        for (const sh of salesHeads(users)) {
            const own = mails.get(sh.id)?.dealers ?? [];
            mails.set(sh.id, {
                recipientId: sh.id,
                email: sh.email,
                name: sh.name,
                dealers: [...own, ...unowned],
                includesUnowned: true,
            });
        }
    }
    return [...mails.values()].map((m) => ({ ...m, dealers: sortOverdue(m.dealers) }));
}

/**
 * Monthly win-back list: each owner gets their Dormant dealers; every Sales
 * Head gets the whole Dormant list (owned and unowned) instead of their own.
 */
export function planWinback(rows: DealerHealthRow[], users: ReminderUser[]): ReminderMail[] {
    const dormant = rows.filter((r) => r.bucket === "dormant");
    if (dormant.length === 0) return [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    const { owned, unowned } = byOwner(dormant, userMap);
    const mails = new Map<string, ReminderMail>();
    for (const [id, list] of owned) {
        const u = userMap.get(id)!;
        mails.set(id, { recipientId: id, email: u.email!, name: u.name, dealers: list, includesUnowned: false });
    }
    for (const sh of salesHeads(users)) {
        mails.set(sh.id, {
            recipientId: sh.id,
            email: sh.email,
            name: sh.name,
            dealers: dormant,
            includesUnowned: unowned.length > 0,
        });
    }
    return [...mails.values()].map((m) => ({ ...m, dealers: sortOverdue(m.dealers) }));
}

/**
 * The CEO alert's key for one dormancy: the dealer and the last invoice it
 * lapsed from. A new invoice followed by a new lapse is a new key.
 */
export function dormancyKey(r: Pick<DealerHealthRow, "key" | "last_order">): string {
    return `${r.key}:${r.last_order ?? "never"}`;
}

/** Dormant dealers the CEO has not been told about yet. */
export function newlyDormant(rows: DealerHealthRow[], alreadyAlerted: Set<string>): DealerHealthRow[] {
    return sortOverdue(rows.filter((r) => r.bucket === "dormant" && !alreadyAlerted.has(dormancyKey(r))));
}

/** The CEO addresses: every active CEO login with an email. */
export function ceoRecipients(users: ReminderUser[]): Array<ReminderUser & { email: string }> {
    return users.filter((u): u is ReminderUser & { email: string } => usable(u) && u.role === "ceo");
}

/** "2026-10" — the win-back period, in IST. */
export function istMonth(istDay: string): string {
    return istDay.slice(0, 7);
}
