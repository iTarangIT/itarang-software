// ID 237: reading a visit's "when" on screen and in CSV. Client-safe (no drizzle).
// The value comes from visitWhenTextSql (lib/visits/visitTime.ts): an ISO instant, or a
// bare date when no time was recorded.

/** A drill / CSV value that is a date with no time ("2026-11-03"). */
export function isDateOnly(v: string | null | undefined): boolean {
    return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** "3 Nov 2026 · no time recorded" for a date-only visit. */
export function dateOnlyWords(v: string): string {
    const d = new Date(`${v}T00:00:00Z`);
    return `${new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(d)} · no time recorded`;
}
