/**
 * The sentence each verification card shows once a verdict exists.
 *
 * Shared because E-242 introduced a second kind of "accepted" and all five
 * cards (Aadhaar, PAN, Bank, CIBIL, RC) had their own copy of the string. A
 * card auto-accepted by the SLA sweep must NOT read "accepted by admin": no
 * admin saw it, and — more importantly — the verification provider was never
 * called, so the green tick means "nobody objected in time", not "verified".
 * Saying so on the card is the only place an admin reviewing the file later
 * will notice.
 */
export function verdictSentence(
    label: string,
    adminAction: string | null | undefined,
    adminActionSource?: string | null,
): string {
    if (!adminAction) return "";

    if (adminActionSource === "system") {
        return adminAction === "accepted"
            ? `${label} auto-accepted by the system — the SLA window passed with no admin action. The verification provider was NOT called.`
            : `${label} ${adminAction} by the system.`;
    }

    return `${label} ${adminAction} by admin.`;
}
