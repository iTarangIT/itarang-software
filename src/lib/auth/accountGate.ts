/**
 * A39 — may this signed-in user use the CRM right now? Pure, client-safe,
 * unit-tested; the server side reads the inputs (passwordMeta.ts) and the
 * dashboard layout acts on the answer.
 *
 *   inactive     users.is_active = false: an ex-employee or a paused login.
 *                Signed out and sent to the login page.
 *   must_change  users.must_change_password: an Admin forced a reset (or a
 *                first login) — every role now, not only NBFC partners.
 *   expired      the password is older than PASSWORD_MAX_AGE_DAYS (90).
 *                Only for users whose change date is known (E-352).
 */

export const PASSWORD_MAX_AGE_DAYS = 90;

export type AccountGate = "inactive" | "must_change" | "expired" | null;

export function decideAccountGate(input: {
    isActive: boolean | null | undefined;
    mustChangePassword: boolean | null | undefined;
    passwordChangedAt: Date | null;
    now: Date;
    maxAgeDays?: number;
}): AccountGate {
    if (input.isActive === false) return "inactive";
    if (input.mustChangePassword) return "must_change";
    if (input.passwordChangedAt) {
        const days = (input.now.getTime() - input.passwordChangedAt.getTime()) / 86_400_000;
        if (days > (input.maxAgeDays ?? PASSWORD_MAX_AGE_DAYS)) return "expired";
    }
    return null;
}

/** Where each gate sends the user. */
export function gateRedirect(gate: Exclude<AccountGate, null>): string {
    if (gate === "inactive") return "/login?inactive=1";
    if (gate === "expired") return "/change-password?expired=1";
    return "/change-password";
}
