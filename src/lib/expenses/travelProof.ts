/**
 * Tracker ID 197 (PJP phase 1) — travel expense proof, the rules. CLIENT-SAFE,
 * pure (no db import). Kartik, 27 Oct: the person submits as today, the CRM
 * never fills or prices the claim, the CEO approves. A Travel or Vehicle/Fuel
 * claim names its day(s); each day is judged on its own by the verified
 * visits (ID 196). Database side: ./travelProofStore.ts.
 */

/** The categories that ask "Which day(s) was this travel?". */
export const TRAVEL_PROOF_CATEGORIES = ["Travel", "Vehicle/Fuel"] as const;

/** How far back a claimed day may go (days before today). */
export const MAX_CLAIM_DAYS_BACK = 31;

export type DayVerdict = "supported" | "not_supported";

export const VERDICT_LABEL: Record<DayVerdict, string> = {
    supported: "Supported",
    not_supported: "Not supported",
};

export function needsTravelProof(category: string | null | undefined): boolean {
    return (TRAVEL_PROOF_CATEGORIES as readonly string[]).includes(category ?? "");
}

/** Supported = at least one verified visit (live GPS + camera photo) that day. */
export function verdictFor(visits: ReadonlyArray<{ verified: boolean }>): DayVerdict {
    return visits.some((v) => v.verified) ? "supported" : "not_supported";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function addDays(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * The claimed days: at least one, each a real date from `today` back up to
 * MAX_CLAIM_DAYS_BACK days, no repeats. Returns them sorted, or the message.
 */
export function checkClaimDays(
    days: readonly string[],
    today: string,
): { ok: true; days: string[] } | { ok: false; message: string } {
    if (days.length === 0) return { ok: false, message: "Pick the day(s) this travel was on." };
    const earliest = addDays(today, -MAX_CLAIM_DAYS_BACK);
    const seen = new Set<string>();
    for (const d of days) {
        if (!ISO.test(d) || addDays(d, 0) !== d) return { ok: false, message: `"${d}" is not a date.` };
        if (d > today) return { ok: false, message: "A travel day cannot be in the future." };
        if (d < earliest) return { ok: false, message: `A travel day can be at most ${MAX_CLAIM_DAYS_BACK} days back.` };
        if (seen.has(d)) return { ok: false, message: `${d} is picked twice.` };
        seen.add(d);
    }
    return { ok: true, days: [...seen].sort() };
}

/** A Not supported day needs the person's note. Returns the first day missing one, or null. */
export function dayMissingNote(
    days: ReadonlyArray<{ day: string; verdict: DayVerdict; note?: string | null }>,
): string | null {
    return days.find((d) => d.verdict === "not_supported" && !(d.note ?? "").trim())?.day ?? null;
}

/** "2 of 3 days supported" — the CEO's Travel proof column. */
export function proofSummary(days: ReadonlyArray<{ verdict: DayVerdict }>): string {
    if (days.length === 0) return "";
    const ok = days.filter((d) => d.verdict === "supported").length;
    return `${ok} of ${days.length} day${days.length === 1 ? "" : "s"} supported`;
}

/** Who approves expenses — the same test as GET /api/admin/expenses (role ceo, or the CEO's login). */
export function isExpenseCeo(user: { role?: string | null; email?: string | null }): boolean {
    return (user.role ?? "").toLowerCase() === "ceo" || (user.email ?? "").toLowerCase() === "sanchit@itarang.com";
}

/** ID 197: the Day evidence is for the CEO and the person who submitted the claim — nobody else. */
export function mayReadTravelProof(viewer: { id: string; role?: string | null; email?: string | null }, submitterId: string): boolean {
    return viewer.id === submitterId || isExpenseCeo(viewer);
}
