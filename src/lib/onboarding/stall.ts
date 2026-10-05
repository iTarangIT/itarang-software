/**
 * Tracker ID 84.1 / 84.3 — who an open dealer onboarding is waiting on, and when
 * that wait counts as a stall. Pure and client-safe; the admin dashboard mirrors
 * the same classification in SQL from the arrays below (admin/dashboard.ts).
 *
 *   waiting on the DEALER   draft, correction requested, or an agreement sent
 *                           and not yet signed — stalled after 7 calendar days
 *                           without an update.
 *   waiting on US           submitted for review, signed agreement awaiting
 *                           approval, agreement not yet initiated or needing a
 *                           re-send (expired / failed) — stalled after 2 working
 *                           days (Mon–Sat, holiday_calendar excluded).
 *   neither                 approved, rejected, withdrawn — not open.
 *
 * Both fire well before the 21-day drop-out review.
 */
import { workingDaysSince } from "@/lib/inside-sales/staleness";

export type OnboardingWaitingOn = "dealer" | "us";

export const STALL_DEALER_DAYS = 7;
export const STALL_US_WORKING_DAYS = 2;

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
): OnboardingWaitingOn | null {
    const on = onboardingWaitingOn(input);
    if (!on || !input.last_activity_at) return null;
    const last = new Date(input.last_activity_at);
    if (Number.isNaN(last.getTime())) return null;
    if (on === "dealer") {
        const days = (now.getTime() - last.getTime()) / 86_400_000;
        return days >= STALL_DEALER_DAYS ? "dealer" : null;
    }
    const wd = workingDaysSince(last, holidayDates, now) ?? 0;
    return wd >= STALL_US_WORKING_DAYS ? "us" : null;
}
