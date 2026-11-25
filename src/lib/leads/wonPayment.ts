/**
 * 25 Nov 2026 (task list items 6 + 7) — Won means the deal closed and the
 * dealer PAID, so Mark Won asks for the payment reference (UTR / cheque /
 * transaction number). CLIENT-SAFE, pure: the Mark Won modal, the route and
 * the WhatsApp Assistant all check it the same way.
 */

/** What Won means, in one sentence — the modal, the status tip and the reports read it. */
export const WON_MEANING =
    "Won = the deal is closed and the dealer has paid (payment reference recorded). Not a Hot lead, and not a submitted onboarding.";

/** 25 Nov item 7: the payment reference as typed — trimmed, inner spaces collapsed. */
export function normalizePaymentReference(v: string | null | undefined): string | null {
    const t = (v ?? "").trim().replace(/\s+/g, " ");
    return t ? t : null;
}

/** Shape check shared by the route, the modal and the Assistant. null = fine. */
export function paymentReferenceProblem(v: string | null | undefined): string | null {
    const t = normalizePaymentReference(v);
    if (!t) return "Enter the payment reference (UTR / transaction number) of the dealer's payment.";
    if (t.length < 6 || t.length > 64) return "The payment reference should be 6 to 64 characters.";
    if (!/^[A-Za-z0-9][A-Za-z0-9 /_.-]*$/.test(t)) return "Use only letters, numbers, spaces and - / _ . in the payment reference.";
    return null;
}
