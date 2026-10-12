/**
 * Tracker ID 84.1 / 84.3 — who an open dealer onboarding is waiting on, and when
 * that wait counts as a stall. Pure and client-safe; the admin dashboard mirrors
 * the same classification in SQL from the arrays below (admin/dashboard.ts).
 *
 *   waiting on the DEALER   draft, correction requested, or an agreement sent
 *                           and not yet signed — stalled after
 *                           onboarding_stall_dealer calendar days (default 7)
 *                           without an update.
 *   waiting on US           submitted for review, signed agreement awaiting
 *                           approval, agreement not yet initiated or needing a
 *                           re-send (expired / failed) — stalled after
 *                           onboarding_stall_us working days (default 2;
 *                           Mon–Sat, holiday_calendar excluded).
 *   neither                 approved, rejected, withdrawn — not open.
 *
 * Both limits are ID 85 time limits (src/lib/timeLimits): server callers pass
 * the values in force (getTimeLimits()); the defaults below are the registry's.
 * Both fire well before the drop-out review.
 */
import { workingDaysSince } from "@/lib/inside-sales/staleness";
import { TIME_LIMIT_DEFAULTS } from "@/lib/timeLimits/registry";

export type OnboardingWaitingOn = "dealer" | "us";

/** Defaults only — the live values come from getTimeLimits(). */
export const STALL_DEALER_DAYS = TIME_LIMIT_DEFAULTS.onboarding_stall_dealer;
export const STALL_US_WORKING_DAYS = TIME_LIMIT_DEFAULTS.onboarding_stall_us;

export type StallLimits = { dealerDays: number; usWorkingDays: number };

/** onboarding_status values that are still in flight. */
export const OPEN_ONBOARDING_STATUSES = ["draft", "submitted", "correction_requested"] as const;
/** onboarding_status values where the dealer has the next move outright. */
export const DEALER_ONBOARDING_STATUSES = ["draft", "correction_requested"] as const;
/** agreement_status values meaning "sent to the dealer, not signed yet". */
export const AGREEMENT_AWAITING_DEALER = [
    "requested",
    "sent_for_signature",
    "sent_to_external_party",
    "sign_pending",
    "viewed",
    "partially_signed",
] as const;

export const STALL_LABEL: Record<OnboardingWaitingOn, string> = {
    dealer: "Stalled · waiting on dealer",
    us: "Stalled · waiting on us",
};

export function onboardingWaitingOn(input: {
    onboarding_status: string | null;
    agreement_status: string | null;
}): OnboardingWaitingOn | null {
    const status = input.onboarding_status ?? "";
    if (!(OPEN_ONBOARDING_STATUSES as readonly string[]).includes(status)) return null;
    if ((DEALER_ONBOARDING_STATUSES as readonly string[]).includes(status)) return "dealer";
    // submitted: the agreement decides whose move it is.
    if ((AGREEMENT_AWAITING_DEALER as readonly string[]).includes(input.agreement_status ?? "")) {
        return "dealer";
    }
    return "us";
}

/**
 * The stall, if any: who it waits on, judged against the application's last
 * update. Null when the onboarding is not open or not (yet) stalled.
 */
export function onboardingStall(
    input: {
        onboarding_status: string | null;
        agreement_status: string | null;
        last_activity_at: string | Date | null;
    },
    holidayDates: Set<string> = new Set(),
    now: Date = new Date(),
    limits: StallLimits = { dealerDays: STALL_DEALER_DAYS, usWorkingDays: STALL_US_WORKING_DAYS },
): OnboardingWaitingOn | null {
    const on = onboardingWaitingOn(input);
    if (!on || !input.last_activity_at) return null;
    const last = new Date(input.last_activity_at);
    if (Number.isNaN(last.getTime())) return null;
    if (on === "dealer") {
        const days = (now.getTime() - last.getTime()) / 86_400_000;
        return days >= limits.dealerDays ? "dealer" : null;
    }
    const wd = workingDaysSince(last, holidayDates, now) ?? 0;
    return wd >= limits.usWorkingDays ? "us" : null;
}
