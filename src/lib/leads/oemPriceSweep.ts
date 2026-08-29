/**
 * E-230 — the daily check on the OEM price register.
 *
 * Two notifications, both to Admin and CEO, both from the requirement
 * (docs/quotation-approval-flow.md §3, items 7 and 8):
 *
 *   "if your August 1st is about to be crossed, a notification should go to
 *    Admin and CEO — the price of this particular model ID is about to become
 *    invalid"
 *   "if there is no pricing, notifications will go saying set the pricing"
 *
 * WHY THIS EXISTS AT ALL. A lapsed reference price is invisible. Nothing errors,
 * no screen turns red; the product simply stops matching the lookup and every
 * quotation containing it starts going to the CEO. The first anyone notices is
 * the approval queue filling up with quotes that used to release themselves. The
 * whole point is to say so BEFORE the date, while adding the next line is still
 * a two-minute job.
 *
 * NAGGING IS THE FAILURE MODE, so both halves are rate-limited, differently
 * because they fail differently:
 *
 *   expiry   once per PRICE LINE, via oem_reference_prices.expiry_notified_at.
 *            Each line has one date and one warning; a line that is warned about
 *            and then extended gets a new row, which gets its own warning.
 *   missing  once per COOLDOWN, via app_settings. An unpriced backlog does not
 *            change day to day, and a daily repeat of the same sentence is how
 *            an audience learns to ignore the bell.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
    listExpiringOemPrices,
    listUnpricedOemProducts,
    markExpiryNotified,
} from "@/lib/leads/oemPrices";
import {
    notifyOemPriceExpiring,
    notifyOemPricesMissing,
} from "@/lib/notifications/events";

/** How much notice to give before a window closes. */
export const DEFAULT_WARN_DAYS = 14;
/** How often the unpriced-backlog reminder may repeat. */
export const MISSING_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

const MISSING_SETTING_KEY = "oem_price_missing_notified_at";

export interface OemPriceSweepResult {
    /** Lines warned about on this run. */
    expiring: number;
    /** Lines within the window that already have a successor queued. */
    expiring_covered: number;
    /** Models with no price in force. */
    missing: number;
    /** Of those, how many once had a price that ran out. */
    missing_lapsed: number;
    /** Whether the backlog reminder was sent, or held back by the cooldown. */
    missing_notified: boolean;
    error?: string;
}

async function lastMissingNotice(): Promise<number> {
    try {
        const [row] = await db
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, MISSING_SETTING_KEY))
            .limit(1);
        if (!row) return 0;
        const v = row.value as { at?: string };
        const t = v?.at ? new Date(v.at).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
    } catch {
        // A missing app_settings row, or a DB without the table, must not stop
        // the expiry half — which is the half that has a deadline.
        return 0;
    }
}

async function stampMissingNotice(at: Date): Promise<void> {
    const value = { at: at.toISOString() };
    await db
        .insert(appSettings)
        .values({ key: MISSING_SETTING_KEY, value, updated_at: at })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: { value, updated_at: at },
        });
}

/**
 * Run both checks. Never throws — this is a background sweep, and a failure
 * here must not take the ticker down with it.
 */
export async function runOemPriceSweep(
    opts: { warnDays?: number } = {},
): Promise<OemPriceSweepResult> {
    const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;
    const result: OemPriceSweepResult = {
        expiring: 0,
        expiring_covered: 0,
        missing: 0,
        missing_lapsed: 0,
        missing_notified: false,
    };

    try {
        // ── 1. Windows about to close ────────────────────────────────────────
        const expiring = await listExpiringOemPrices(warnDays);
        const uncovered = expiring.filter((e) => !e.has_successor);
        result.expiring_covered = expiring.length - uncovered.length;

        if (uncovered.length > 0) {
            await notifyOemPriceExpiring({
                items: uncovered.map((e) => ({
                    product_name: e.product_name,
                    model_id: e.model_id,
                    valid_until: e.valid_until,
                })),
            });
            result.expiring = uncovered.length;
        }

        // Stamped for EVERY line inside the window, covered or not, and only
        // after the notification went out. A line that already had a successor
        // was deliberately not mentioned, and re-examining it tomorrow would
        // only produce the same silence — while leaving it unstamped means a
        // later deletion of that successor never re-warns anybody either, which
        // is the honest trade: the register screen shows that case in red, and
        // deleting a scheduled line is a deliberate act.
        if (expiring.length > 0) {
            await markExpiryNotified(expiring.map((e) => e.price_id));
        }

        // ── 2. Models with nothing in force ──────────────────────────────────
        const unpriced = await listUnpricedOemProducts();
        result.missing = unpriced.length;
        result.missing_lapsed = unpriced.filter((u) => u.lapsed).length;

        if (unpriced.length > 0) {
            const since = Date.now() - (await lastMissingNotice());
            if (since >= MISSING_COOLDOWN_MS) {
                await notifyOemPricesMissing({
                    total: unpriced.length,
                    lapsed: result.missing_lapsed,
                    // Lapsed ones first: they are the regression, and the three
                    // names that fit in the message should be the ones that
                    // stopped working rather than three of the never-priced
                    // backlog.
                    examples: [...unpriced]
                        .sort((a, b) => Number(b.lapsed) - Number(a.lapsed))
                        .map((u) => u.product_name || u.model_id)
                        .filter(Boolean),
                });
                await stampMissingNotice(new Date());
                result.missing_notified = true;
            }
        }
    } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
}
